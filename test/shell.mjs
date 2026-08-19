#!/usr/bin/env node
//
// Is every page still an app shell, with the chrome out of the viewport's hands?
//
//     npm test
//     node test/shell.mjs
//
// The bug (bc-7utr, inherited by bc-khoe.1 when Adam superseded it): on a phone neither
// bar stayed still. The bar along the bottom was `position: fixed` and the top bar
// `position: sticky` on a document that scrolled, and both of those are laid out against
// the **layout** viewport while what you are looking at is the **visual** one. On iOS
// those are not the same rectangle — the URL bar collapses as you scroll down and grows
// back as you scroll up, moving the layout viewport under a fixed element, and a
// rubber-band overscroll translates the whole page with its fixed children in tow. The
// bottom bar slid half off the screen. No amount of arithmetic fixes that, because the
// numbers are right and the rectangle they are measured against is the one that moves.
//
// So the document does not scroll: `body` is one viewport tall and clipped, a flex column
// of top bar, pill row and the page's own scroller, and that last row is the only thing
// with `overflow-y: auto`. Nothing is positioned against a viewport that moves because no
// viewport moves — with no document scroll there is no URL-bar collapse to react to.
//
// This is a **static** suite on purpose. `scripts/topbar-check.mjs` drives the real pages
// in a real Chrome at both phone widths and is worth far more than this — but it is not
// in `npm test` (it needs Chrome), so it is not what a delivery actually runs. What is
// asserted here is the handful of declarations that, if any one of them goes, puts the
// bug back:
//
//   * neither row of chrome is `fixed` or `sticky` — that *is* the bug, spelled;
//   * `body` still carries the four declarations that make the shell a shell, and `html`
//     is clipped too (with only `body` clipped, iOS still bounces the root);
//   * `.pagescroll` keeps `min-height: 0`, without which a flex item grows to its content
//     and pushes everything else off the screen — the same symptom as before, wearing a
//     different mechanism;
//   * every page marks a scroller, or is named here as one that has nothing to scroll;
//   * the pill row stays over the 44px a thumb needs;
//   * no page reaches for `window.scrollY` or `window.scrollTo` again. Those are the
//     quiet failure: on a shell they read and write 0 forever, so a repaint that
//     "restores your place" throws it away and nothing anywhere says so.
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

const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
// Comments out, because half of this file argues about `position: fixed` in prose and a
// grep that cannot tell an argument from a declaration is a grep that reports the
// argument.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declarations of a top-level rule, by exact selector.
 *
 * Top-level only — a rule of this name inside `@media (orientation: landscape)` is a
 * different rule with a different job. Returns every match, because a selector may
 * legitimately appear twice.
 */
const rules = (selector) => {
  const out = [];
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 'g');
  for (const m of bare.matchAll(re)) out.push(m[2]);
  return out;
};
const has = (selector, decl) => rules(selector).some((body) => new RegExp(decl).test(body));

/* --------------------------------------------- the chrome is not in the viewport */

console.log('\nthe two rows of chrome');

for (const bar of ['.topbar', '.viewbar']) {
  const bodies = rules(bar);
  check(`${bar} is declared`, bodies.length === 1, `${bodies.length} top-level rules`);
  const positioned = bodies.filter((b) => /position\s*:\s*(fixed|sticky)/.test(b));
  check(
    `${bar} is neither fixed nor sticky — it is a row of the shell`,
    positioned.length === 0,
    positioned.join(' | ').trim()
  );
  check(`${bar} does not stretch — flex: none`, has(bar, 'flex\\s*:\\s*none'));
}

/* The bar along the bottom is gone outright (bc-khoe.1) and so is everything that
   reserved room for it. A `.tabbar` back in this stylesheet is not a regression of the
   shell — it is the whole navigation decision being undone by accident. */
check(
  'nothing draws a bar along the bottom again',
  !/\.tabbar\b/.test(bare) && !/\.has-tabbar\b/.test(bare) && !/--tabbar-h\b/.test(bare),
  'the tab bar, or the padding that held space for it, is back in public/style.css'
);
check('and public/tabbar.js is still deleted', !fs.existsSync(path.join(PUBLIC, 'tabbar.js')));

/* ---------------------------------------------------------------- the shell itself */

console.log('\nthe shell');

for (const decl of ['position\\s*:\\s*fixed', 'inset\\s*:\\s*0', 'display\\s*:\\s*flex', 'flex-direction\\s*:\\s*column', 'overflow\\s*:\\s*hidden']) {
  check(`body carries ${decl.replace(/\\s\*/g, ' ').replace(/\\/g, '')}`, has('body', decl));
}
check('and html is clipped too, or iOS still bounces the root', has('html', 'overflow\\s*:\\s*hidden'));

console.log('\nthe scroller');

check('.pagescroll takes the slack — flex: 1', has('.pagescroll', 'flex\\s*:\\s*1'));
check(
  'and min-height: 0, without which it grows instead of scrolling',
  has('.pagescroll', 'min-height\\s*:\\s*0')
);
check('and it is the thing that scrolls', has('.pagescroll', 'overflow-y\\s*:\\s*auto'));
check(
  'a flick past the end does not become a gesture on what is behind the page',
  has('.pagescroll', 'overscroll-behavior\\s*:\\s*contain')
);
/* `.card` is `overflow: hidden`, and a flex item that clips has an automatic minimum
   size of **zero** — so without this every card in a list squashes to a fraction of its
   height to make the whole list fit one screen, and still looks like a list. */
check('and its children do not shrink to fit the screen', has('.pagescroll > *', 'flex-shrink\\s*:\\s*0'));

/* ------------------------------------------- every page with chrome has a scroller */

console.log('\nevery page');

/* A page with a top bar and no `.pagescroll` is a page whose content cannot be reached
   past the first screenful — so each one is either marked or named here with why. */
const NO_SCROLLER = {
  'graph.html': 'the graph pans and zooms its own canvas (.graph-main); there is nothing to scroll',
  'login.html': 'one centred card, and `.login-body` undoes the shell for exactly that reason',
};

for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const marked = /class="[^"]*\bpagescroll\b/.test(html);
  const why = NO_SCROLLER[file];
  if (why) check(`${file} has nothing to scroll — ${why}`, !marked, 'it marks a .pagescroll after all, so drop it from NO_SCROLLER');
  else check(`${file} marks the one element that scrolls`, marked, 'no class="… pagescroll …" anywhere on the page');
}

/* --------------------------------------------------------------- the tap target */

console.log('\nthe pill row is still a tap target');

const TAP_FLOOR = 44;
const heights = [...css.matchAll(/--viewbar-h\s*:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
check('--viewbar-h is set', heights.length > 0);
check(
  `every value of --viewbar-h is at least ${TAP_FLOOR}px`,
  heights.every((h) => h >= TAP_FLOOR),
  `found ${heights.join(', ')}px`
);
check(
  'and a whole pill is the target — .viewpill is min-height: var(--viewbar-h)',
  has('.viewpill', 'min-height\\s*:\\s*var\\(--viewbar-h\\)')
);
/* The row is the thing that must not wrap: a second line of navigation on a 360px phone
   is what the whole of bc-khoe exists to stop, and there will be roughly nine pills. */
check('the row scrolls sideways rather than wrapping', has('.viewbar', 'overflow-x\\s*:\\s*auto'));
check('and no pill is allowed to squeeze or stretch', has('.viewpill', 'flex\\s*:\\s*none'));
/* The counts on the four Home pills (bc-khoe.23) land on a 25-second poll, so the badge
   has to be a fixed width or the pills to its right shuffle under a thumb already moving
   to one of them. Two declarations, both about the same promise: `min-width` holds one
   digit to the width of two, and `tabular-nums` holds the digits to each other. */
check('a count does not change the width of the pill it is on', has('.viewpill-count', 'min-width'));
check('and its digits are all one width', has('.viewpill-count', 'font-variant-numeric\\s*:\\s*tabular-nums'));

/* ------------------------------------------------- nothing scrolls the window again */

console.log('\nnobody scrolls the window');

const offenders = [];
for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).sort()) {
  const js = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  // Comments out: app.js explains at length why `window.scrollY` was the wrong number,
  // and the explanation is the reason this assertion exists rather than a breach of it.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/window\.(scrollY|scrollTo)\b/g)) offenders.push(`${file}: window.${m[1]}`);
}
check(
  'no page reads window.scrollY or calls window.scrollTo — on a shell both are 0 forever',
  offenders.length === 0,
  offenders.join(', ')
);

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
