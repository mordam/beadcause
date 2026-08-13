#!/usr/bin/env node
//
// Where the in-app terminal is reached from.
//
//   npm test
//   node test/termdoor.mjs
//
// The terminal is the least-opened surface in the app and it used to own a ⌨️ in the
// inbox header — the most-opened screen. bc-l8jp.2 moved the door to /admin, which is
// already the page about what is running on this Mac rather than about beads, and left
// everything behind the door alone: the /terminal route, term.html, term.js and the
// /api/terminal* endpoints did not move an inch.
//
// That shape is easy to lose by accident twice over, in opposite directions. A later
// pass over the inbox header — bc-l8jp is a whole epic of them — can put a ⌨️ back
// without knowing it was ever a decision; and a pass over /admin, which is the noisiest
// page in the app for merges (pause, TLS, pairing all land there), can drop the only
// remaining door and leave the terminal reachable by typed URL only. Neither shows up
// in any other suite: test/pagepaths.mjs proves /terminal *answers*, which it would go
// on doing with nothing anywhere linking to it.
//
// Source text rather than a live DOM, deliberately. What is being asserted is which
// document holds the link, and reading the two files says that in a way that cannot be
// confused by a service worker serving a stale copy of either.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** HTML comments blanked, newlines kept, so the prose *about* the move — which quotes
 *  the old markup on purpose — is never read as the markup itself. */
const uncommented = (src) => src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

const index = uncommented(read('public/index.html'));
const admin = uncommented(read('public/admin.html'));
const app = read('public/app.js');
const css = read('public/style.css');
const sw = read('public/sw.js');

console.log('\nthe terminal door\n');

/* ------------------------------------------------------- off the inbox header */

// Any /terminal href at all, seeded or not: the header is the whole of index.html's
// chrome, and the bead-scoped one lives in app.js (below) rather than in this file.
const inIndex = index.match(/href="\/terminal[^"]*"/g) || [];
check(
  'no terminal link in the inbox markup',
  inIndex.length === 0,
  inIndex.length ? `found ${inIndex.join(', ')} in public/index.html` : ''
);

// The rest of the header is still there. A ⌨️ removed by deleting the row it sat in
// would pass the check above and take two working doors with it.
check('the endorsement queue is still in the header', index.includes('href="/endorse"'));
check('foundations is still in the header', index.includes('href="/foundations"'));

/* --------------------------------------------------------------- on to /admin */

const inAdmin = admin.match(/href="\/terminal[^"]*"/g) || [];
check(
  'admin has exactly one door to the terminal',
  inAdmin.length === 1,
  `found ${inAdmin.length}: ${inAdmin.join(', ') || 'none'} in public/admin.html`
);
check(
  'it is plain /terminal, so it opens an unseeded one',
  inAdmin[0] === 'href="/terminal"',
  `it is ${inAdmin[0] || 'missing'}`
);
// Static markup, which is the point of putting it in the .html at all: everything
// admin.js draws is behind /api/admin answering with a payload this build understands,
// and an older daemon collapses that whole block to one sentence saying so.
check(
  'the door is in the document, not drawn by admin.js',
  !read('public/admin.js').includes('/terminal'),
  'public/admin.js has a /terminal link in it — it belongs in the markup'
);
// The anchor wears .primary, which was written for a <button> in a flex row.
check('.admin-door exists to make an anchor wear .primary', /^\.admin-door\s*\{/m.test(css));
check('the door uses it', admin.includes('admin-door'));

/* ------------------------------------------------- what did not move, and must not */

// The usual way a terminal is actually opened: from a bead's menu, with the bead
// already seeded into it. Unaffected by this move, and the reason taking the header
// button away costs the inbox nothing.
check(
  "a bead's menu still opens a seeded terminal",
  /href="\/terminal\?ws=/.test(app),
  'menuHtml in public/app.js no longer offers a terminal'
);
// A bookmark or home-screen shortcut pointed straight at it. pagepaths.mjs proves the
// route answers; this proves the offline shell still carries it, which is what makes
// the shortcut work on a phone with no Tailscale route up yet.
for (const asset of ['/terminal', '/term.html', '/term.js']) {
  check(`the service worker still precaches ${asset}`, sw.includes(`'${asset}'`));
}
// And the two documents this move splits itself across are both in that shell, so they
// have to arrive together: a phone holding the old `/` beside the new `/admin` shows
// the ⌨️ twice, and the old `/admin` beside the new `/` leaves no standing door at all.
check(
  'the cache version was bumped past v27, so the pair arrives together',
  /const CACHE = 'beadcause-v(2[8-9]|[3-9]\d)'/.test(sw),
  `it is ${sw.match(/const CACHE = '([^']+)'/)?.[1]}`
);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
