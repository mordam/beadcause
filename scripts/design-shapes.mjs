// One-off: the distinct class= combinations one of the app's files emits, so the
// design manifest copies real markup instead of inventing plausible markup.
// Usage: node scripts/design-shapes.mjs monitor.js [prs.js …]
import { readFileSync } from 'node:fs';

for (const f of process.argv.slice(2)) {
  const src = readFileSync(`public/${f}`, 'utf8');
  const seen = new Set();
  for (const m of src.matchAll(/<(\w+)[^>]*?class="([^"]*)"/g)) {
    // Drop the template holes — `${…}` inside a class list tells us nothing.
    const cls = m[2].replace(/\$\{[^}]*\}/g, '⟨?⟩').replace(/\s+/g, ' ').trim();
    if (cls && cls !== '⟨?⟩') seen.add(`${m[1]}.${cls}`);
  }
  console.log(`\n=== ${f} (${seen.size}) ===`);
  for (const s of [...seen].sort()) console.log('  ' + s);
}
