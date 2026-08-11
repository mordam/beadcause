#!/usr/bin/env node
/**
 * Copy the browser builds into public/vendor so the phone loads nothing from a
 * CDN — the whole app has to work over a tailnet with no internet route.
 *
 * It also has an opinion about `node_modules`, and the reason is bc-mf9s. A worktree of
 * this repo is meant to *borrow* the main checkout's dependency tree with a symlink; four
 * that installed their own instead were 160 MB each and half the retired-worktree attic.
 * This file is the likeliest reason they did: it runs first in a fresh worktree, finds
 * nothing to copy, and used to answer "run npm install" — which in a worktree is exactly
 * the wrong move and takes thirty seconds to be sure it worked. `borrowAdvice` below says
 * the other thing, and `lib/tidy.js`'s `slimAttic` cleans up after the ones that don't.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

/** `.claude/worktrees/<name>` — three levels down from the main checkout, not four. */
const WORKTREES = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
const inWorktree = (root + path.sep).includes(WORKTREES);

/**
 * What to do about `node_modules` here, in one line, or null when there is nothing to
 * say — which is the main checkout, and a worktree that already borrows correctly.
 *
 * Two cases, and they read almost the same to a person in a hurry, which is why both are
 * spelled out with the command rather than described:
 *
 * - **nothing installed**: link, do not install. Seven "missing X — run npm install"
 *   warnings below are otherwise the whole message a fresh worktree gets.
 * - **a real directory**: this already *is* a private copy — printed after a
 *   `postinstall`, so it is the only moment anybody sees it happen. It works fine, which
 *   is the problem: nothing else will ever mention the 160 MB again until the attic
 *   sweep drops it.
 */
function borrowAdvice() {
  if (!inWorktree) return null;
  const link = 'rm -rf node_modules && ln -s ../../../node_modules node_modules';
  let st;
  try {
    st = fs.lstatSync(path.join(root, 'node_modules'));
  } catch {
    return `[vendor] this is a worktree — borrow the main checkout's tree instead of installing one:\n         ln -s ../../../node_modules node_modules`;
  }
  if (st.isSymbolicLink()) return null; // borrowed, which is the whole idea
  if (!st.isDirectory()) return null;
  return `[vendor] this worktree has its own node_modules (~160 MB) rather than a symlink to the main\n         checkout's. It works, but it is carried into .claude/worktrees-retired/ when the\n         worktree is retired, and beadcause's attic sweep will drop it. To borrow instead:\n         ${link}`;
}

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
    // "run npm install" only where that is the right answer. In a worktree it is the
    // wrong one, and the advice printed after the loop says so instead.
    console.warn(`[vendor] missing ${from}${inWorktree ? '' : ' — run npm install'}`);
    continue;
  }
  fs.copyFileSync(src, path.join(out, to));
  copied++;
}
console.log(`[vendor] ${copied}/${files.length} browser bundles in public/vendor`);
const advice = borrowAdvice();
// Last, so it is the line still on screen after seven warnings or a `postinstall`.
if (advice) console.warn(advice);
