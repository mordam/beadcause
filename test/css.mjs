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
      const block = { line, prelude, atRule: prelude.startsWith('@'), parent: stack[stack.length - 1] || null };
      found.push(block);
      stack.push(block);
      preludeStart = i + 1;
    } else if (c === '}') {
      const closed = stack.pop();
      if (!closed) found.push({ line, prelude: '', stray: true, atRule: false, parent: null });
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
