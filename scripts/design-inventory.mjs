// One-off inventory: every class style.css defines, and where the app's markup uses it.
// Not shipped — it is how the design-system bundle's grouping was derived. `node scripts/design-inventory.mjs`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync('public/style.css', 'utf8');
const classes = new Set();
for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(m[1]);

const files = readdirSync('public').filter(f => /\.(html|js)$/.test(f));
const markup = new Map();
for (const f of files) markup.set(f, readFileSync(join('public', f), 'utf8'));

const esc = s => s.replace(/[-]/g, '\\-');
const rows = [];
for (const c of [...classes].sort()) {
  const re = new RegExp(`class=["'\`][^"'\`]*\\b${esc(c)}\\b|classList\\.[a-z]+\\(['"\`]${esc(c)}['"\`]`, 'g');
  const used = [];
  for (const [f, src] of markup) {
    const n = (src.match(re) || []).length;
    if (n) used.push(`${f}:${n}`);
  }
  const defs = (css.match(new RegExp(`\\.${esc(c)}\\b`, 'g')) || []).length;
  rows.push({ cls: c, defs, used });
}
console.log(JSON.stringify(rows));
