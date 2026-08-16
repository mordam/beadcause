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
 *
 * **In a worktree the seven files are links, not copies (bc-oqu7).** Once `node_modules`
 * and the gradle output had been dropped from the attic, `public/vendor` *was* the attic:
 * 4.2 MB of every ~6 MB entry, the same seven files 123 times, ~500 MB of a 636 MB
 * directory. `slimAttic` deliberately will not drop them — every browser check refuses to
 * start without them, and rebuilding them needs the dependency tree that was just dropped,
 * so an entry that loses them stops being resumable in one command. So this goes the other
 * direction, which is the trick `node_modules` already uses: borrow the main checkout's
 * copy. A link costs bytes, keeps the entry runnable, survives retirement (the retired
 * path is the same depth as the live one, so a *relative* link still resolves), and takes
 * a normal attic entry to about 2 MB.
 *
 * The link goes on the seven files and never on the directory: a symlinked `public/vendor`
 * shows up as `?? public/vendor` in git status (`.gitignore`'s `public/vendor` pattern has
 * no trailing slash — bc-slxm — precisely so a *symlinked directory* still matches, but a
 * worktree that does that anyway breaks something else: git refuses to resolve any path
 * *underneath* a symlinked directory at all, which is what test/gitignoreresidue.mjs hits,
 * bc-0i27.25) and `bin/deliver.js` refuses the delivery at the very end, after the suite has
 * passed. A real directory holding seven links is ignored exactly as a real directory
 * holding seven copies is — which is also the trick `node_modules` uses, one level up.
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
 * The main checkout this worktree hangs off, or null in the main checkout itself.
 *
 * Everything before `/.claude/worktrees/`, which is where the borrowed `node_modules`
 * already points and where the seven bundles below are borrowed from.
 */
const mainCheckout = inWorktree ? (root + path.sep).slice(0, (root + path.sep).indexOf(WORKTREES)) : null;

/**
 * How far up `public/vendor/<file>` sits from the checkout that owns it: vendor, public,
 * <name>, worktrees, .claude — five. Relative rather than absolute on purpose. Retirement
 * *moves* the worktree to `.claude/worktrees-retired/<name>`, which is the same depth, so
 * a relative link goes on resolving where an absolute one would only have looked like it
 * did; and it survives the main checkout being renamed or moved as a whole.
 */
const UP_TO_MAIN = path.join('..', '..', '..', '..', '..');

/**
 * Borrow one bundle from the main checkout, replacing whatever is there.
 *
 * Returns false when the main checkout has not built its own vendor directory yet — a
 * clone that has never run `npm install` — in which case the caller copies, because a
 * dangling link is worse than 600 KB.
 */
function borrowBundle(to) {
  if (!mainCheckout || !fs.existsSync(path.join(mainCheckout, 'public', 'vendor', to))) return false;
  const dest = path.join(out, to);
  // rmSync rather than an existence test: what is there may be a copy from before this
  // change, a stale link, or nothing, and symlinkSync refuses to overwrite any of them.
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(path.join(UP_TO_MAIN, 'public', 'vendor', to), dest);
  return true;
}

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
let borrowed = 0;
for (const [from, to] of files) {
  // The borrow is tried *before* node_modules is consulted, which is what makes a fresh
  // worktree work at all: it has no dependency tree yet, and the seven warnings it used
  // to print were the whole of its vendor step. The main checkout has the files either
  // way, so there is nothing to install first.
  if (borrowBundle(to)) {
    borrowed++;
    continue;
  }
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
const how = borrowed ? ` (${borrowed} linked to ${mainCheckout.replace(/\/$/, '')})` : '';
console.log(`[vendor] ${copied + borrowed}/${files.length} browser bundles in public/vendor${how}`);
const advice = borrowAdvice();
// Last, so it is the line still on screen after seven warnings or a `postinstall`.
if (advice) console.warn(advice);
