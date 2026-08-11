#!/usr/bin/env node
//
// One rule for closing a subordinate view, and one place it is written.
//
//   npm test
//   node test/closeview.mjs
//
// The bug (bc-l8jp.3): the ✕ on a subordinate view meant three different things,
// because three files each answered the question for themselves.
//
//   - `public/session.js` closed to `/sessions`. Correct on the day it was written,
//     and the day Advocates absorbed the sessions view it became a ✕ that closed one
//     view by *opening a different tab* — the reported symptom, a close that lands
//     you on a board rather than back where you were.
//   - `public/doc.js` and `public/graph.js` closed to `/`, each with its own copy of
//     the window.close()-then-navigate dance.
//   - `public/drawer.js` dismisses to the tab underneath, which is right for a panel
//     over a tab and is the only exit in the app that can land you on the PR board.
//
// None of the three was individually wrong enough to notice. What was wrong was that
// there were three: changing what closing means was three edits, and the third was
// always the one that got forgotten — which is exactly how `/sessions` outlived the
// sessions view.
//
// So the rule lives in `public/drawer.js` — header for the prose, `closeView()` for
// the code — and this suite asserts the property that keeps it there: **no page
// decides its own way out.** A static read of the source, deliberately, and for the
// same reason `test/routes.mjs` reads the route chain rather than calling it: the
// point is to catch the *fourth* implementation on the day it is written, in a file
// this suite has never heard of, rather than to re-check the three that are correct
// right now.
//
// `scripts/drawer-check.mjs` is the other half and a different kind of claim: it
// drives the real pages in a real browser and asserts where each ✕ actually lands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nclosing a subordinate view\n');

/* The three pages a drawer can be. Each is also a standalone page — a pasted URL, a
   long-press → new tab, a notification — which is the only case where its own ✕ runs
   at all, and so the only case this is about. */
const VIEWS = [
  { js: 'doc.js', html: 'doc.html', button: 'doc-close' },
  { js: 'graph.js', html: 'graph.html', button: 'graph-close' },
  { js: 'session.js', html: 'session.html', button: 'session-close' },
];

/** Comments are where the old destinations are *described*, which is not deciding one. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

/* ------------------------------------------------- nobody decides their own way out */

for (const view of VIEWS) {
  const src = code(read(view.js));
  check(
    () => assert.match(src, /window\.beadcause\.closeView\(\)/),
    `${view.js} asks for the rule rather than implementing one`
  );
  check(
    () => assert.doesNotMatch(src, /window\.close\s*\(/),
    `${view.js} does not call window.close() itself`
  );
  // The one that actually broke: a page naming the page it closes to.
  check(
    () => assert.doesNotMatch(src, /location\.(href|replace)\s*[=(]\s*['"`]\//),
    `${view.js} names no destination of its own`
  );
}

/* --------------------------------------------------- and the rule is in one place */

const drawer = read('drawer.js');

check(() => {
  const defined = fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /(?:function\s+closeView|closeView\s*[:=]\s*(?:function|\())/.test(code(read(f))));
  assert.deepEqual(defined, ['drawer.js'], `defined in ${defined.join(', ') || 'nowhere'}`);
}, 'closeView() is defined exactly once, in drawer.js');

check(
  () => assert.match(code(drawer), /const HOME\s*=\s*'\/'/),
  'and the page it closes to when nothing is underneath is the inbox, named once'
);

// The regression itself, spelled out: the sessions view is gone, and `/sessions` now
// serves Advocates. A close that goes there is a close that opens a different tab.
check(() => {
  const guilty = fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /location\.(?:href|replace)\s*[=(]\s*['"`]\/sessions/.test(code(read(f))));
  assert.deepEqual(guilty, [], `still closes to the Advocates page: ${guilty.join(', ')}`);
}, 'nothing closes to /sessions — the view that path was named for was absorbed');

/* ------------------------------------------- the export is there when the ✕ is tapped */

// `closeView` is looked up at click time, so load order does not matter — but the
// file has to be on the page at all, and a ✕ whose handler throws is a ✕ that does
// nothing at all. This is the one thing that would make the three calls above a lie.
for (const view of VIEWS) {
  const html = read(view.html);
  check(
    () => assert.match(html, /<script src="\/drawer\.js"><\/script>/),
    `${view.html} loads drawer.js, so the rule exists when its ✕ is tapped`
  );
  check(
    () => assert.match(html, new RegExp(`id="${view.button}"`)),
    `${view.html} still has the ✕ the rule is for`
  );
}

// And the service worker keeps it in the shell: a cached page whose drawer.js had to
// be fetched is a page whose ✕ does nothing on a bad link — which is exactly the
// moment (a notification, on a phone, off the tailnet) these pages are opened.
check(
  () => assert.match(read('sw.js'), /'\/drawer\.js'/),
  'and the service worker precaches drawer.js, so it is there offline too'
);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
