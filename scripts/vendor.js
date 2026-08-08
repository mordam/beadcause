#!/usr/bin/env node
/**
 * Copy the browser builds into public/vendor so the phone loads nothing from a
 * CDN — the whole app has to work over a tailnet with no internet route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['marked/lib/marked.umd.js', 'marked.js'],
  ['dompurify/dist/purify.min.js', 'purify.js'],
  ['mermaid/dist/mermaid.min.js', 'mermaid.js'],
  // What `bd graph --html` loads from d3js.org — see lib/graph.js.
  ['d3/dist/d3.min.js', 'd3.js'],
  // The in-app terminal. The CSS is not optional decoration: without it xterm.js
  // renders its rows stacked with no positioning at all, which looks like a broken
  // page rather than a missing stylesheet.
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm-addon-fit.js'],
];

let copied = 0;
for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.warn(`[vendor] missing ${from} — run npm install`);
    continue;
  }
  fs.copyFileSync(src, path.join(out, to));
  copied++;
}
console.log(`[vendor] ${copied}/${files.length} browser bundles in public/vendor`);
