// The parser is only trustworthy if it puts style.css back together byte for byte.
import { readFileSync } from 'node:fs';
import { parse } from './cssslice.mjs';

const css = readFileSync('public/style.css', 'utf8');
const nodes = parse(css);
const back = nodes.map(n => n.raw).join('');
if (back !== css) {
  let i = 0; while (i < css.length && css[i] === back[i]) i++;
  console.error('MISMATCH at byte', i);
  console.error('want:', JSON.stringify(css.slice(i - 80, i + 80)));
  console.error('got :', JSON.stringify(back.slice(i - 80, i + 80)));
  process.exit(1);
}
const rules = nodes.filter(n => n.type === 'rule');
const ats = nodes.filter(n => n.type === 'atrule');
console.log(`round-trip ok — ${nodes.length} nodes, ${rules.length} rules, ${ats.length} at-rules`);
console.log('at-rules:', [...new Set(ats.map(a => a.prelude.split(/[\s({]/)[0]))].join(' '));
