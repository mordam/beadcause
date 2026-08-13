#!/usr/bin/env node
//
// Is the stylesheet still one flat list of rules?
//
//   npm test
//   node test/css.mjs
//
// The bug (found while working bc-4irq, which needed to add a rule and could not make
// it apply): `#save-dialog textarea` had lost its closing brace and seven of its nine
// declarations, and `.key` a hundred lines below had been given them. A merge did it —
// two rules of nearly identical shape, both `border/border-radius/background/color/
// font`, and the resolution took the tail of one into the middle of the other.
//
// What made it expensive is that CSS *nesting* is now real. An unclosed rule is no
// longer a parse error that eats one declaration: every rule after it parses as a
// perfectly valid nested rule of it, and applies only to things inside
// `#save-dialog textarea`. So the whole tail of the file — the advocate console, the
// admin page, five hundred lines — silently applied to nothing. The page still
// rendered. The brace count still balanced, because a stray `}` further down closed
// the block early. Nothing in the app, in the tests, or in a browser console said one
// word about it, and the only symptom was that the console looked slightly plain.
//
// So this asserts the property that makes that visible: **a selector block contains no
// other block.** This stylesheet nests only under at-rules (`@media`, `@keyframes`,
// `@supports`), where the nesting is the point. That is a real restriction and it is
// chosen deliberately: giving up nested syntax buys a truncated rule that fails loudly
// on the next `npm test` instead of quietly for a week.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/**
 * Comments and quoted strings blanked, newlines kept.
 *
 * Blanked rather than removed so every line number this reports is the line number in
 * the file — a structural complaint you have to go and count lines for is half a
 * complaint. Strings go too: `content: "}"` is legal and would otherwise be read as
 * the brace that closes a rule.
 */
const blank = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));

/** Every block in the file, in the order they open, with what opened them. */
function blocks(src) {
  const s = blank(src);
  const found = [];
  const stack = [];
  let line = 1;
  let preludeStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') line++;
    if (c === '{') {
      const prelude = s.slice(preludeStart, i).trim().replace(/\s+/g, ' ');
      // `opens`/`closes` are offsets of the braces themselves, so a block's body is
      // src.slice(opens + 1, closes) — what the duplicate check below reads.
      const block = { line, prelude, atRule: prelude.startsWith('@'), parent: stack[stack.length - 1] || null, opens: i, closes: -1 };
      found.push(block);
      stack.push(block);
      preludeStart = i + 1;
    } else if (c === '}') {
      const closed = stack.pop();
      if (closed) closed.closes = i;
      else found.push({ line, prelude: '', stray: true, atRule: false, parent: null, opens: i, closes: i });
      preludeStart = i + 1;
    } else if (c === ';') {
      preludeStart = i + 1;
    }
  }
  return { found, unclosed: stack };
}

for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'))) {
  console.log(`\n${file}`);
  const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const { found, unclosed } = blocks(src);

  check(
    'every block is closed',
    unclosed.length === 0,
    unclosed.map((b) => `line ${b.line}: ${b.prelude} { … never closed`).join('\n      ')
  );

  const strays = found.filter((b) => b.stray);
  check('and nothing is closed twice', strays.length === 0, strays.map((b) => `line ${b.line}: a } with no {`).join('\n      '));

  // The one that catches the truncation: a rule that swallowed the rest of the file
  // shows up as every following rule being nested inside it.
  const nested = found.filter((b) => b.parent && !b.parent.atRule);
  check(
    'a rule contains declarations only, never another rule',
    nested.length === 0,
    nested
      .slice(0, 5)
      .map((b) => `line ${b.line}: "${b.prelude}" is nested inside "${b.parent.prelude}" (line ${b.parent.line})`)
      .join('\n      ') + (nested.length > 5 ? `\n      …and ${nested.length - 5} more` : '')
  );
}

/* ------------------------------------------------------- one bar, one selector (bc-4aw)
 *
 * The other way a rule goes quiet: not truncated, but written twice. `.tabs` was
 * declared once for the agents page's four tabs and again, four hundred lines below,
 * for the monitor's two. Same selector, same specificity, one stylesheet — so the
 * later block won every property they shared and each bar was half-drawn by the other
 * page's rule. Nothing looked wrong, which is what made it expensive: the next edit to
 * either bar would have moved a page its author was not looking at.
 *
 * So each bar owns a selector of its own, and this says so out loud. It is deliberately
 * narrow — the general "no top-level selector appears twice" check wants the rest of the
 * file's duplicates resolved first (bc-297u, bc-5orx, bc-b4dk) — but these two are the
 * pair that already collided, and a fix nothing asserts is a fix waiting to be merged
 * back over.
 */

console.log('\nthe tab bars');

{
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const top = blocks(css).found.filter((b) => !b.atRule && !b.parent && !b.stray);
  const linesOf = (sel) => top.filter((b) => b.prelude === sel).map((b) => b.line);

  for (const sel of ['.agent-tabs', '.mon-tabs']) {
    const at = linesOf(sel);
    check(`${sel} is declared exactly once`, at.length === 1, at.length ? `also at line ${at.join(', ')}` : 'declared nowhere');
  }

  check(
    'and the bare .tabs both bars used to share is gone',
    linesOf('.tabs').length === 0,
    `line ${linesOf('.tabs').join(', ')}: .tabs is back, and whichever bar is second wins`
  );

  // The other half of the pair: a selector nothing wears is as dead as one written
  // twice, so the markup is asked which class each bar is actually carrying.
  const wears = (file, cls) => new RegExp(`class="[^"]*\\b${cls.slice(1)}\\b`).test(fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
  check('the agents page wears .agent-tabs', wears('foundations.html', '.agent-tabs'));
  check('the monitor wears .mon-tabs', wears('monitor.html', '.mon-tabs'));
  check('and neither page wears the other bar’s class', !wears('foundations.html', '.mon-tabs') && !wears('monitor.html', '.agent-tabs'));
}

/* ------------------------------------------- a flex row says it is one (bc-8l74)
 *
 * The third way a rule goes quiet, after truncated and written-twice: written for a
 * layout the element never got. `.mon-card .work-head` had `align-items: center` and
 * `flex-wrap: wrap` and no `display: flex` — the `.svc-set` idiom copied onto an element
 * whose other class does not supply one, so for as long as the rule existed the console's
 * card heads laid out as blocks and stacked the name, the state and the controls on three
 * lines. `.adv-actions { margin-left: auto }` was dead beside it, for the same reason.
 * Nothing said a word: two properties that do nothing render as the layout you would have
 * had without them.
 *
 * The general form of this — "no block sets a flex-container property unless something
 * gives that element a flex display" — is not a stylesheet-only question. Five live rules
 * here (`.svc-set`, `.agent-row`, `.board-row`, `.pr-card .pr-row`, `.mon-times`) are
 * modifier classes on a base that supplies the display, and telling those from a dead rule
 * needs the markup, not the CSS. That is bc-ah0v. This is the narrow half: the one head
 * that was actually broken, and the single selector that now draws all four of them.
 */

console.log('\nthe console card head');

{
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const monitor = fs.readFileSync(path.join(PUBLIC, 'monitor.js'), 'utf8');
  const top = blocks(css).found.filter((b) => !b.atRule && !b.parent && !b.stray);
  const head = top.filter((b) => b.prelude === '.mon-card .work-head');

  check('.mon-card .work-head is declared exactly once', head.length === 1, `declared ${head.length} times`);

  // The body of that one block, read from the file between its brace and the next.
  const body = (() => {
    if (head.length !== 1) return '';
    const from = css.split('\n').slice(head[0].line - 1).join('\n');
    return from.slice(from.indexOf('{') + 1, from.indexOf('}'));
  })();

  check(
    'and the rule that gives it flex properties also gives it a flex display',
    /flex-wrap|align-items/.test(body) && /display:\s*flex/.test(body),
    body.trim().replace(/\s+/g, ' ')
  );

  // The other half of bc-8l74: the space card carried its own copy of the same rule,
  // with the same missing display. It is a `.mon-card` too, so the rule above reaches
  // it and a second copy is only a copy to keep in step.
  check(
    'and the space card has no second copy of it',
    top.filter((b) => /\.space-card\s+\.work-head/.test(b.prelude)).length === 0,
    top.filter((b) => /\.space-card\s+\.work-head/.test(b.prelude)).map((b) => `line ${b.line}: ${b.prelude}`).join(', ')
  );

  // Which is only true while every card on the page wears `mon-card` — and `work-card`,
  // which is the padding. The space card was the one without it, and lived off the 20px
  // of margin an unstyled <h2> brings until that margin went.
  const articles = [...monitor.matchAll(/<article class="([^"$]*)/g)].map((m) => m[1]);
  check(`every card /monitor draws wears mon-card (${articles.length} of them)`, articles.length >= 5 && articles.every((c) => /\bmon-card\b/.test(c)), articles.filter((c) => !/\bmon-card\b/.test(c)).join(' | '));
  check('and wears work-card, so it is padded', articles.every((c) => /\bwork-card\b/.test(c)), articles.filter((c) => !/\bwork-card\b/.test(c)).join(' | '));
}

/* ------------------------------------------ one paint for a pressed chip (bc-wx2e)
 *
 * The fourth way a rule goes quiet, after truncated, written-twice and written-for-a-
 * layout-it-never-got: written twice with *different quoting*, so that a grep for
 * either one comes back looking conclusive.
 *
 * `.chip[aria-pressed="true"]` set the filled accent and `var(--accent-ink)` to go on
 * it. Four hundred lines below, `.chip[aria-pressed='true']` — the composer's quiet
 * wash for a suggestion chip — set a 16% background and no colour at all. Same
 * specificity, so the wash won the background and the ink stayed near-black on it:
 * measured 1.0:1 in the dark theme and 1.6:1 in the light one, on *every* pressed chip
 * in the app, and one control (`.show-dismissed`, bc-es8) had already grown a private
 * `color` to escape it. The wash is a real intent, but it is the composer's, and it is
 * scoped to `.suggested` now.
 *
 * Two properties keep that settled, and neither needs a browser. Only one selector may
 * paint a pressed chip app-wide; and any rule that gives a pressed chip a background
 * must name its ink in the same block, because a background from one rule and a colour
 * from another is exactly the pair that was unreadable. The quoting is asserted too —
 * one spelling, so that grepping for it is honest.
 */

console.log('\nthe pressed chip');

{
  // Comments go, quotes stay — `blank()` above blanks strings too, and here the
  // quoting *is* the thing being asserted.
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const at = (i) => css.slice(0, i).split('\n').length;

  // Every rule in the file as { selector, body, line }. Safe as a flat scan because
  // the checks at the top of this file already refuse a selector block inside another;
  // an @media wrapper simply never matches, and the rules inside it do.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
    line: at(m.index + m[1].search(/\S/)),
  }));

  const singleQuoted = rules.filter((r) => /\[aria-pressed='/.test(r.selector));
  check(
    'a pressed chip is spelled one way, so a grep for it is conclusive',
    singleQuoted.length === 0,
    singleQuoted.map((r) => `line ${r.line}: ${r.selector} — the other rules say [aria-pressed="true"]`).join('\n      ')
  );

  // Rules that reach the chip itself (not a descendant, not a sibling) and paint it.
  const paints = rules.filter(
    (r) => /\.chip(?:[.:][\w-]+)*\[aria-pressed=["']true["']\]$/.test(r.selector) && /(?:^|;|\s)(?:background|color)\s*:/.test(r.body)
  );

  const bare = paints.filter((r) => /^\.chip\[aria-pressed=["']true["']\]$/.test(r.selector));
  check(
    'exactly one rule paints a pressed chip everywhere',
    bare.length === 1,
    bare.length
      ? `also at ${bare.slice(1).map((r) => `line ${r.line}`).join(', ')} — same specificity, so they split the paint between them`
      : 'nothing unscoped paints a pressed chip at all'
  );

  const inkless = paints.filter((r) => /(?:^|;|\s)background\s*:/.test(r.body) && !/(?:^|;|\s)color\s*:/.test(r.body));
  check(
    'and every rule that gives one a background names its ink in the same block',
    inkless.length === 0,
    inkless.map((r) => `line ${r.line}: ${r.selector} sets a background and takes its colour from somewhere else`).join('\n      ')
  );

  // The composer's exception, named — a wash whose scope is the reason it is allowed.
  const scoped = rules.filter((r) => /^\.suggested \.chip\[aria-pressed=["']true["']\]$/.test(r.selector));
  check(
    'the composer’s quiet wash is scoped to .suggested, not to every chip',
    scoped.length === 1 && /color-mix/.test(scoped[0].body),
    scoped.length ? scoped[0].body.trim().replace(/\s+/g, ' ') : 'gone — or unscoped again'
  );

  // bc-es8's workaround, which only existed because the two rules disagreed.
  const escapee = rules.filter((r) => /^\.show-dismissed\[aria-pressed=["']true["']\]$/.test(r.selector));
  check(
    'and no control carries a private colour to escape the collision',
    escapee.length === 0,
    escapee.map((r) => `line ${r.line}: ${r.selector}`).join(', ')
  );
}

/* --------------------------------------- a flex row says it is one, everywhere (bc-ah0v)
 *
 * The general form of the third one. `.mon-card .work-head` above is the instance that
 * was actually broken; this is the property that would have caught it the day it was
 * written, and catches the next one: **no block sets a flex-container property unless
 * something gives that element a flex or grid display.**
 *
 * It cannot be answered from the stylesheet alone, which is why it took a second bead.
 * Fourteen live rules here set `align-items`/`gap`/`flex-wrap`/… without a `display` of
 * their own, and every one of them is the same shape as the bug — a rule whose element
 * is supposed to get its display from somewhere else. Five of those get it from a *base
 * class on the same element* (`.svc-set` on `.svc`, `.agent-row` on `.chip-row`,
 * `.board-row` and `.pr-card .pr-row` on `.work-row`, `.mon-times` on `.meta`), which the
 * CSS cannot see: only the markup knows those classes are ever worn together. So the
 * markup is read too, the way `wears()` above reads it, and each rule is resolved in two
 * stages:
 *
 *   1. the stylesheet, where it can. A rule whose selector is *reached by* a display rule
 *      — same key compound plus extra qualifiers, and no ancestor the display rule does
 *      not also require — is settled without asking anybody: `.chip-row.scopes` is fine
 *      because `.chip-row` is `display: flex`.
 *   2. the markup, for the rest. Every `class="…"` and `.className =` in `public/*.html`
 *      and `public/*.js` becomes an element with a class list; a rule is fine if every
 *      element that could wear its key compound is given a flex display by *some* rule.
 *
 * Two deliberate limits, both in the permissive direction, because a layout guard that
 * cries wolf gets deleted. Ancestors are ignored when matching an element (a display from
 * `.dialog .row` counts for a `.row` anywhere), and a display inside an `@media` counts at
 * every width. What is left is still the exact shape of the bug: an element that *nothing
 * anywhere* lays out as a flex container, carrying properties that only a flex container
 * reads.
 *
 * The third outcome is the one worth keeping honest: a rule the markup cannot speak for
 * at all, because its class is only ever built at runtime (`row.className = \`chip-row
 * ${g.id}s\``). Those are reported as failures rather than skipped — a check with a
 * silent "don't know" bucket is a check that empties into it. The way out is to write the
 * class where a grep can see it, or, if it genuinely cannot be written down, to put the
 * `display` in the same block as the properties that need it, which is what the rule
 * should have said in the first place.
 */

console.log('\nevery flex property has a flex container');

/** Simple selectors of one compound — pseudo-classes and attribute tests dropped. */
const compound = (part) => {
  const bare = part.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  return {
    classes: [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    id: (bare.match(/#([A-Za-z0-9_-]+)/) || [])[1] || null,
    tag: (bare.match(/^([a-zA-Z][a-zA-Z0-9]*)/) || [])[1] || null,
  };
};

/** One selector as its chain of compounds, keyed on the last. */
const chain = (sel) => {
  const parts = sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).map(compound);
  return { sel: sel.trim(), parts, key: parts[parts.length - 1], combinator: /[>+~]/.test(sel) };
};

/** Nothing to go on: `*`, or a compound that was pseudo-classes only. */
const anything = (c) => !c.classes.length && !c.id && !c.tag;

/** `a` asks for no more than `b` does. */
const implies = (a, b) => a.classes.every((x) => b.classes.includes(x)) && (!a.id || a.id === b.id) && (!a.tag || a.tag === b.tag);

/** An element could wear this compound. A tagless element (a `.className =`) matches any tag. */
const wornBy = (c, el) => c.classes.every((x) => el.classes.has(x)) && (!c.id || c.id === el.id) && (!c.tag || !el.tag || c.tag === el.tag);

/** Everything `c` reaches, `g` reaches too: same key, and no ancestor `c` does not have. */
function reaches(g, c) {
  if (g.combinator || anything(g.key) || !implies(g.key, c.key)) return false;
  let i = c.parts.length - 2;
  for (let j = g.parts.length - 2; j >= 0; j--) {
    while (i >= 0 && !implies(g.parts[j], c.parts[i])) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}

const FLEX_PROP = /(?:^|;)\s*(align-items|align-content|justify-content|justify-items|place-items|place-content|flex-wrap|flex-flow|flex-direction|gap|row-gap|column-gap)\s*:/;
const FLEX_DISPLAY = /(?:^|;)\s*display\s*:\s*(?:inline-)?(?:flex|grid)/;

/**
 * Class lists the markup can actually produce. A `${…}` in a class attribute is dropped,
 * but any quoted string inside it is kept — `class="prop-field${f.pills ? ' pills' : ''}"`
 * is the only place `.prop-field.pills` is ever written down.
 */
function elements(dir) {
  const tokens = (value) => {
    const out = [];
    const literal = value.replace(/\$\{([\s\S]*?)\}/g, (_, inner) => {
      for (const q of inner.matchAll(/(["'])([A-Za-z0-9_ -]*)\1/g)) out.push(...q[2].split(/\s+/));
      return ' ';
    });
    out.push(...literal.split(/\s+/));
    return out.filter((c) => /^[A-Za-z0-9_-]+$/.test(c));
  };

  const found = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.(html|js)$/.test(f))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
      const cls = m[2].match(/class\s*=\s*(["'`])([\s\S]*?)\1/);
      if (!cls) continue;
      found.push({ file, tag: m[1].toLowerCase(), classes: new Set(tokens(cls[2])), id: (m[2].match(/id\s*=\s*["'`]([A-Za-z0-9_-]+)/) || [])[1] || null });
    }
    for (const m of text.matchAll(/\.className\s*=\s*(["'`])([\s\S]*?)\1/g)) {
      found.push({ file, tag: null, classes: new Set(tokens(m[2])), id: null });
    }
  }
  return found;
}

/** Every selector setting flex-container properties for something no rule lays out as one. */
function auditFlex(css, els) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rules = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2],
    line: src.slice(0, m.index).split('\n').length,
    atRule: m[1].trim().startsWith('@'),
  }));

  const givers = rules.filter((r) => !r.atRule && FLEX_DISPLAY.test(r.body)).flatMap((r) => r.selectors.map((s) => ({ ...chain(s), line: r.line })));
  const dead = [];
  const mute = [];

  for (const rule of rules) {
    if (rule.atRule || !FLEX_PROP.test(rule.body) || FLEX_DISPLAY.test(rule.body)) continue;
    for (const sel of rule.selectors) {
      const c = chain(sel);
      if (anything(c.key)) continue;
      const settled = givers.find((g) => reaches(g, c));
      if (settled) continue;
      const worn = els.filter((el) => wornBy(c.key, el));
      if (!worn.length) {
        mute.push({ line: rule.line, sel });
        continue;
      }
      const orphan = worn.find((el) => !givers.some((g) => !anything(g.key) && wornBy(g.key, el)));
      if (orphan) dead.push({ line: rule.line, sel, el: orphan, props: rule.body.trim().replace(/\s+/g, ' ') });
    }
  }
  return { dead, mute, rules: rules.length, givers: givers.length };
}

{
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const els = elements(PUBLIC);
  const { dead, mute } = auditFlex(css, els);

  check(`the markup is readable at all (${els.length} elements with a class)`, els.length > 500, `only ${els.length} found — the readers below are matching nothing`);

  check(
    'no rule sets flex-container properties for an element nothing lays out as flex',
    dead.length === 0,
    dead
      .slice(0, 6)
      .map((d) => `line ${d.line}: "${d.sel}" — <${d.el.tag || 'el'} class="${[...d.el.classes].join(' ')}"> in ${d.el.file} is given no flex display by any rule\n        ${d.props}`)
      .join('\n      ') + (dead.length > 6 ? `\n      …and ${dead.length - 6} more` : '')
  );

  check(
    'and every such rule names a class the markup writes down, so it can be asked',
    mute.length === 0,
    mute.map((m) => `line ${m.line}: "${m.sel}" matches nothing in public/*.html or public/*.js — write the class where a grep can see it, or put the display in the block`).join('\n      ')
  );
}

/* The same argument as the wreck above: a guard that cannot fail is one nobody should
 * trust. So it is shown the bug it exists for — the real stylesheet with the one
 * `display: flex` bc-8l74 added taken back off — and the four-line shapes either side of
 * it, so that "passes" is not just "matches nothing". */
{
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const els = elements(PUBLIC);
  const undone = css.replace('.mon-card .work-head { display: flex; ', '.mon-card .work-head { ');

  check('taking the display back off .mon-card .work-head is a change at all', undone !== css);
  const { dead } = auditFlex(undone, els);
  check(
    'and the general check catches it, not just the narrow one above',
    dead.some((d) => d.sel === '.mon-card .work-head'),
    dead.map((d) => d.sel).join(', ') || 'nothing reported'
  );

  const el = [{ file: 'x.js', tag: 'div', classes: new Set(['head']), id: null }];
  check(
    'a bare flex property with no display anywhere is dead',
    auditFlex('.head { align-items: center; }', el).dead.length === 1
  );
  check(
    'the same rule is fine once some other rule lays the element out',
    auditFlex('.head { align-items: center; }\n.head { display: flex; }', el).dead.length === 0
  );
  const modifier = [{ file: 'x.js', tag: 'div', classes: new Set(['row', 'tight']), id: null }];
  check(
    'and a modifier class is fine when the markup wears the base class too',
    auditFlex('.row { display: flex; }\n.tight { gap: 2px; }', modifier).dead.length === 0,
    'the markup half is not being consulted'
  );
  check(
    'but not when nothing wears them together',
    auditFlex('.row { display: flex; }\n.tight { gap: 2px; }', [{ file: 'x.js', tag: 'div', classes: new Set(['tight']), id: null }]).dead.length === 1
  );
  check(
    'a rule for a class the markup never writes down is reported rather than skipped',
    auditFlex('.ghost { gap: 2px; }', el).mute.length === 1
  );
}

/* ------------------------------------------- one selector, one block (bc-b4dk)
 *
 * The general form of "the tab bars" above, which this file has been asking for since
 * bc-4aw and could not have without the duplicates being resolved first. Four selectors
 * were written twice at top level: `.tabs` (bc-4aw), `.chip[aria-pressed]` with
 * different quoting (bc-wx2e), the bare `.chip` (bc-297u/bc-syzm) and the entire drawer
 * section, nine blocks of it, two hundred lines apart (bc-5orx).
 *
 * Every one of them rendered perfectly. That is the whole difficulty: a duplicated
 * selector is not a parse error and not a visual fault, it is a *later block quietly
 * winning*, and the cost is paid by the next person to edit the copy that loses. The
 * `.chip` pair had been drawing every filter chip in the composer's paint for as long
 * as both existed, and the block written beside the filter chips contributed one
 * property out of nine.
 *
 * The assertion is not "a selector appears once", though, because this stylesheet
 * deliberately writes some twice and is right to: `:root { --tabbar-h: 54px }` sits with
 * the tab bar rules that read it rather than eight hundred lines away with the palette,
 * and `.icon-btn { position: relative }` sits with the badge it positions. Neither can
 * silently win anything, because neither touches a property the other block sets. So
 * the property asserted is the one that actually distinguishes those from the four
 * bugs: **no block may re-declare a property an earlier block with the same selector
 * already declared.** Additive is fine and needs no allowlist to stay fine; overriding
 * at the same specificity, from another part of the file, is the bug.
 *
 * "The same property" has to account for shorthands or the check is trivially evaded —
 * a second block setting `padding-left` against a first setting `padding` collides just
 * as silently. A shorthand is taken to cover its own dashed longhands (`padding` covers
 * `padding-left`, `font` covers `font-size`), plus the handful of families whose names
 * do not share a prefix (`gap`/`row-gap`, `inset`/`top`, `place-items`/`align-items`,
 * `flex-flow`/`flex-wrap`). Custom properties compare by exact name only, so a
 * `--tabbar-h` beside a `--tabbar` is two variables and not a collision.
 *
 * The known limit, in the permissive direction on purpose: an exotic shorthand not in
 * that map is read as its own property, so a collision through it would go unreported.
 * That is the hole this check already closed most of, not a new one — and a guard that
 * failed the build on a legitimate additive block is a guard that gets an allowlist,
 * then an ignored allowlist, then deleted.
 */

/** Longhand families whose members do not share the shorthand's own name. */
const FAMILIES = {
  gap: ['row-gap', 'column-gap'],
  inset: ['top', 'right', 'bottom', 'left'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  overflow: ['overflow-x', 'overflow-y'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
};

/** Property names a declaration writes to, shorthands expanded to what they cover. */
const covers = (prop) => new Set([prop, ...(FAMILIES[prop] || [])]);

/** Two declarations touch the same thing: same name, one a dashed longhand of the other,
 *  or one a named member of the other's family. Custom properties match exactly. */
function collides(a, b) {
  if (a === b) return true;
  if (a.startsWith('--') || b.startsWith('--')) return false;
  if (a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true;
  const [ca, cb] = [covers(a), covers(b)];
  return [...ca].some((x) => cb.has(x));
}

/** The property names a block's body declares, in source order. */
function declared(body) {
  const out = [];
  for (const part of body.split(';')) {
    const m = part.match(/^\s*(--[A-Za-z0-9_-]+|[a-zA-Z-]+)\s*:/);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/**
 * Every place a top-level block re-declares something an earlier block with the same
 * selector already said. Returns one entry per colliding property, which is what makes
 * the failure readable: the selector, both line numbers, and the property itself.
 */
function overrides(css) {
  const top = blocks(css).found.filter((b) => !b.atRule && !b.parent && !b.stray);
  // Bodies are read from the *blanked* source, which is the same length, so the offsets
  // still line up. Reading the raw text instead loses any declaration a comment sits in
  // front of — `.drawer`'s `padding-top` is preceded by two lines about the notch, and
  // splitting the raw body on `;` leaves the comment glued to the property name.
  const bare = blank(css);
  const seen = new Map(); // prelude -> [{ prop, line }]
  const out = [];
  for (const b of top) {
    const props = declared(bare.slice(b.opens + 1, b.closes));
    const before = seen.get(b.prelude) || [];
    for (const prop of props) {
      const clash = before.find((p) => collides(p.prop, prop));
      if (clash) out.push({ sel: b.prelude, prop, line: b.line, first: clash.line, firstProp: clash.prop });
    }
    seen.set(b.prelude, [...before, ...props.map((prop) => ({ prop, line: b.line }))]);
  }
  return out;
}

console.log('\none selector, one block');

{
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const clashes = overrides(css);
  check(
    'no top-level block re-declares a property an earlier block with the same selector set',
    clashes.length === 0,
    clashes
      .slice(0, 8)
      .map((c) => `line ${c.line}: ${c.sel} sets ${c.prop} again — line ${c.first} already set ${c.firstProp}`)
      .join('\n      ') + (clashes.length > 8 ? `\n      …and ${clashes.length - 8} more` : '')
  );

  // The two the stylesheet writes twice on purpose, named so that deleting either the
  // rule or this check is a deliberate act rather than a silent one.
  const top = blocks(css).found.filter((b) => !b.atRule && !b.parent && !b.stray);
  const twice = [...new Set(top.map((b) => b.prelude))].filter((s) => top.filter((b) => b.prelude === s).length > 1);
  check(
    'and the only selectors written twice are the two additive one-liners',
    twice.length === 2 && twice.includes(':root') && twice.includes('.icon-btn'),
    twice.join(', ') || 'none at all'
  );

  // The four that were actually broken, each asserted by name: a fix nothing asserts is
  // a fix waiting to be merged back over.
  const linesOf = (sel) => top.filter((b) => b.prelude === sel).map((b) => b.line);
  for (const sel of ['.chip', '.drawer', '.drawer-wrap', '.drawer-head']) {
    check(`${sel} is declared exactly once`, linesOf(sel).length === 1, `at line ${linesOf(sel).join(', ') || '— nowhere'}`);
  }
  check(
    'and the composer’s chip restyles itself under .suggested',
    top.some((b) => b.prelude === '.suggested .chip'),
    'the second bare .chip is gone but nothing replaced it — the suggestion chips are unstyled'
  );
}

{
  // The detector, shown both shapes. `.a` overriding its own padding is the bug;
  // `.b` adding a property its earlier block never set is the deliberate case.
  const bug = '.a { padding: 4px; color: red; }\n.a { padding: 8px; }\n';
  check('a second block that re-sets a property is caught', overrides(bug).length === 1, JSON.stringify(overrides(bug)));
  check('an additive second block is not', overrides('.b { color: red; }\n.b { position: relative; }\n').length === 0);
  check('a longhand against a shorthand is caught', overrides('.a { padding: 4px; }\n.a { padding-left: 8px; }\n').length === 1);
  check('and a family member whose name does not share the prefix', overrides('.a { gap: 4px; }\n.a { row-gap: 8px; }\n').length === 1);
  check('two custom properties with a shared prefix are two properties', overrides(':root { --a-b: 1px; }\n:root { --a: 2px; }\n').length === 0);
  check(
    'a re-declaration inside an at-rule is a media override, not a collision',
    overrides('.a { width: 10px; }\n@media (min-width: 700px) { .a { width: 20px; } }\n').length === 0
  );
  // The one this got wrong first time round, and the reason bodies are read blanked:
  // `.drawer` sets `padding-top` under two lines of comment about the notch, and reading
  // the raw body hid it — the check reported nine of `.drawer`'s ten collisions and
  // called that a pass for the tenth.
  check(
    'a declaration a comment sits in front of is still seen',
    overrides('.a { padding-top: 1px; }\n.a {\n  /* why */\n  padding-top: 2px;\n}\n').length === 1
  );
  check(
    'and a property name inside a comment is not a declaration',
    overrides('.a { color: red; }\n.a { /* color: red; */ position: relative; }\n').length === 0
  );
}

/* ------------------------------------------------------------------ the detector works
 *
 * A guard that cannot fail is a guard nobody should trust, and this one would have
 * passed the broken file on brace count alone. So it is shown the exact wreck.
 */

console.log('\nthe detector itself');

{
  const wreck = `.a {\n  width: 100%;\n.b { color: red; }\n.c { color: blue; }\n`;
  const { found, unclosed } = blocks(wreck);
  check('an unclosed rule is caught even when the braces balance', unclosed.length === 1, JSON.stringify(unclosed.map((b) => b.prelude)));
  check(
    'and the rules it swallowed are named as nested',
    found.filter((b) => b.parent && !b.parent.atRule).length === 2,
    JSON.stringify(found.map((b) => b.prelude))
  );
}

{
  const fine = `@media (prefers-color-scheme: dark) {\n  .a { color: red; }\n}\n@keyframes p { from { opacity: 0 } to { opacity: 1 } }\n.b::after { content: "}"; }\n`;
  const { found, unclosed } = blocks(fine);
  check('an at-rule may hold rules, and a brace in a string is not a brace', unclosed.length === 0 && !found.some((b) => b.stray));
  check('and nothing inside one is reported', found.filter((b) => b.parent && !b.parent.atRule).length === 0);
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
