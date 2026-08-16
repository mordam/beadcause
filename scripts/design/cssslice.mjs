// Slice public/style.css into the rules one component actually needs.
//
// A design-system card has to render on its own, and style.css is 293 KB — far too
// much to inline forty times over. So the card gets three things: the token block
// (always, it is what makes the two themes work), the element-level base rules, and
// only those rules whose selectors mention one of the component's own classes.
//
// The parser is a brace walker rather than a regex. Selectors here contain commas,
// parentheses (`:not()`, `color-mix()`), and attribute strings, and nesting goes two
// deep inside `@media` — a regex over that is the kind of thing that silently drops
// a rule and leaves a card looking almost right.

/** Split a stylesheet body into top-level nodes, keeping the comments above each. */
export function parse(css) {
  const nodes = [];
  let i = 0, chunkStart = 0;

  const skipString = (q) => { // i is on the quote
    i++;
    while (i < css.length) {
      if (css[i] === '\\') { i += 2; continue; }
      if (css[i] === q) { i++; return; }
      i++;
    }
  };

  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { skipString(c); continue; }
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }

    if (c === ';') { // at-rule with no block (@import, @charset)
      const raw = css.slice(chunkStart, i + 1);
      nodes.push(raw.trim() ? { type: 'statement', raw, prelude: raw.trim() } : { type: 'trailing', raw, prelude: '' });
      i++; chunkStart = i; continue;
    }

    if (c === '{') {
      const preludeRaw = css.slice(chunkStart, i);
      const bodyStart = i + 1;
      let depth = 1; i++;
      while (i < css.length && depth > 0) {
        const d = css[i];
        if (d === '"' || d === "'") { skipString(d); continue; }
        if (d === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        i++;
      }
      const body = css.slice(bodyStart, i - 1);
      const { lead, prelude } = splitLead(preludeRaw);
      nodes.push({
        type: prelude.startsWith('@') ? 'atrule' : 'rule',
        lead, prelude, body,
        raw: css.slice(chunkStart, i),
      });
      chunkStart = i; continue;
    }
    i++;
  }
  const tail = css.slice(chunkStart);
  if (tail) nodes.push({ type: 'trailing', raw: tail, prelude: '' });
  return nodes;
}

/** Separate leading comments/whitespace from the selector itself. */
function splitLead(raw) {
  let i = 0;
  for (;;) {
    const before = i;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] === '/' && raw[i + 1] === '*') { const e = raw.indexOf('*/', i + 2); i = e < 0 ? raw.length : e + 2; continue; }
    if (i === before) break;
  }
  return { lead: raw.slice(0, i), prelude: raw.slice(i).trim() };
}

/** Every class name a selector mentions. */
export function selectorClasses(sel) {
  return new Set([...sel.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]));
}

/** A selector with no class at all — `body`, `button`, `a:focus-visible`, `*`. */
export function isElementOnly(sel) {
  return !/[.#]/.test(sel);
}

const ROOTISH = /^(:root|html|body|\*)\b/;

/**
 * Build one component's stylesheet.
 *
 * @param {string} css        the whole of style.css
 * @param {Set<string>} want  class names this component is built from
 * @param {object} opts       { base: include element-level rules }
 */
export function slice(css, want, opts = {}) {
  const { base = true } = opts;
  const nodes = parse(css);
  const out = [];
  const keptSelectors = [];

  const wants = (sel) => {
    for (const c of selectorClasses(sel)) if (want.has(c)) return true;
    return false;
  };
  const keepRule = (node) => {
    const sel = node.prelude;
    if (ROOTISH.test(sel)) return true;                       // tokens, page ground
    if (isElementOnly(sel)) return base;                      // the reset
    return wants(sel);
  };

  for (const node of nodes) {
    if (node.type === 'rule') {
      if (keepRule(node)) { out.push(node.raw); keptSelectors.push(node.prelude); }
      continue;
    }
    if (node.type === 'atrule') {
      const at = node.prelude.split(/[\s({]/)[0].toLowerCase();
      if (at === '@keyframes' || at === '@font-face' || at === '@property') { out.push(node.raw); continue; }
      // @media / @supports / @layer — recurse, and keep the wrapper only if something survives.
      const inner = parse(node.body).filter(n => n.type !== 'trailing');
      const kept = [];
      for (const n of inner) {
        if (n.type === 'rule' ? keepRule(n) : true) { kept.push(n.raw); if (n.type === 'rule') keptSelectors.push(n.prelude); }
      }
      if (kept.length) out.push(`${node.lead}${node.prelude} {${kept.join('')}\n}`);
      continue;
    }
    if (node.type === 'statement') out.push(node.raw);
  }

  return { css: out.join('').trim(), selectors: keptSelectors };
}

/** Drop @keyframes nothing references, so a card is not carrying the whole animation set. */
export function pruneKeyframes(cssText) {
  const nodes = parse(cssText);
  const names = new Set();
  for (const n of nodes) {
    if (n.type === 'atrule' && /^@keyframes/i.test(n.prelude)) continue;
    for (const m of (n.raw || '').matchAll(/animation(?:-name)?\s*:[^;}]*/gi)) {
      for (const w of m[0].matchAll(/[A-Za-z_][\w-]*/g)) names.add(w[0]);
    }
  }
  return nodes
    .filter(n => !(n.type === 'atrule' && /^@keyframes/i.test(n.prelude) && !names.has(n.prelude.split(/\s+/)[1])))
    .map(n => n.raw).join('').trim();
}
