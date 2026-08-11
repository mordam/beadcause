#!/usr/bin/env node
//
// The Mirror is a pane on the advocates page, not a tab of its own.
//
//   npm test
//   node test/mirrorpane.mjs
//
// bc-3xb: `public/tabbar.js` and `public/mirror.js` landed in the same window, which
// left `/monitor` carrying two rows of tabs — one that moves between pages, one that
// swaps a pane — and an open question about which row the Mirror belongs on. It is a
// pane, for two reasons that are about what the Mirror *is*:
//
//   - It is a **mode** of the advocates page, not a standing view: that page's repos
//     and sessions, seen from the phone rather than from this Mac.
//   - It is the one surface in the app that is **meaningless on a phone**, which is the
//     device a bottom tab is tapped from. It follows *another* device and drops its own,
//     so a phone that tapped a Mirror tab would find nothing to follow.
//
// A third reason was true when it was decided and is not any more — the bar was full at
// five tabs — because PRs left the bar in bc-l8jp.6 and there is a free place on it. That
// is exactly why this file exists: the decision does not depend on the reason that
// expired, and the next person to notice the empty slot should hit an assertion with the
// argument in it rather than re-derive it. A static read of the sources, deliberately, in
// the manner of `test/closeview.mjs`: the point is to catch the *tab* on the day someone
// adds it, not to re-check a pane that is correct right now.
//
// If the decision is ever genuinely reversed, this suite is the thing to delete, and the
// README section it names is the thing to rewrite. It failing is not a bug in the change;
// it is the question being asked again, which is the whole intent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

let failures = 0;
let ran = 0;
const check = (fn, name) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
};

/* Comments are where the decision is *explained*, in all three of these files, so a
   naive grep for "mirror" would match the prose that says it is not a tab and call that
   a tab. Every assertion below reads code with the comments taken out. */
const decomment = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
const uncommentHtml = (src) => src.replace(/<!--[\s\S]*?-->/g, ' ');

console.log('\nthe Mirror is a pane, not a tab\n');

/* -------------------------------------------------------------- not in the bar */

// The bar's tab list is the one place a tab can be added, which is what makes this the
// assertion that matters. `TABS` is a literal array of object literals, so the slice
// between the declaration and the line that closes it is the whole list.
const tabbar = decomment(read('tabbar.js'));
const list = tabbar.match(/const TABS = \[([\s\S]*?)\n {2}\];/);

check(() => assert.ok(list, 'could not find the TABS array in public/tabbar.js'), 'the bar still keeps its tabs in one list');

if (list) {
  check(
    () => assert.doesNotMatch(list[1], /mirror/i, 'a Mirror tab is in the bottom bar — see README, "The Mirror is a pane, not a tab"'),
    'no Mirror tab in the bottom bar'
  );

  // The reason a tab would be wrong is that the Mirror is not a place. Nothing else in
  // the bar should acquire a path into it either — a tab pointed at /monitor is the
  // advocates page, which is correct, but one pointed at a mirror URL is the same
  // decision made in a different spelling.
  check(
    () => assert.doesNotMatch(list[1], /['"]\/mirror/, 'a tab points at a /mirror URL'),
    'and no tab points at a mirror URL'
  );
}

/* ------------------------------------------------- and so has no page of its own */

// The two things the other answer would have cost, per the bead. Both absent means the
// pane is not quietly being kept alongside a second implementation.
check(
  () => assert.ok(!fs.existsSync(path.join(PUBLIC, 'mirror.html')), 'public/mirror.html exists'),
  'there is no mirror.html — the pane has no standalone page'
);

const server = decomment(fs.readFileSync(path.join(ROOT, 'lib', 'server.js'), 'utf8'));
check(
  () => assert.doesNotMatch(server, /urlPath === '\/mirror'/, 'lib/server.js rewrites a /mirror path onto a page'),
  'and no /mirror route — every page path in the app is rewritten in lib/server.js'
);

/* ---------------------------------------------------------- the pane is still there */

// The other half of the same claim: "not a tab" is only true while it is a pane. A
// Mirror that had quietly been deleted would pass everything above.
const monitor = uncommentHtml(read('monitor.html'));

check(
  () => assert.match(monitor, /id="mon-tabs"[\s\S]*?data-tab="mirror"[\s\S]*?<\/nav>/, 'the Mirror chip is not in #mon-tabs on monitor.html'),
  'the Mirror is a chip in the advocates page\'s own tab row'
);
check(
  () => assert.match(monitor, /<section id="mirror" class="work" hidden>/),
  'and the pane it swaps to is a .work section on that same page'
);
check(
  () => assert.match(monitor, /<script src="\/mirror\.js"><\/script>/),
  'which monitor.html loads mirror.js to fill'
);

// The pane-swap is one `hidden` attribute and this one rule. The bead named dropping it
// as part of the cost of the other answer, so it is part of what the decision keeps.
check(
  () => assert.match(fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8'), /\.work\[hidden\]\s*\{[^}]*display:\s*none/),
  'and the swap still rests on style.css\'s .work[hidden] rule'
);

/* --------------------------------------------------- the second reason is still true */

// "Meaningless on the device a bottom tab is tapped from" is not an opinion about the
// Mirror, it is a property of this code: the pane drops its own device from the list it
// follows, and stops reporting a view of its own while it is up. If either half ever goes
// away the mirror can follow itself, and the argument above stops holding — which is a
// reason to re-open bc-3xb rather than to quietly leave this file passing.
const mirror = decomment(read('mirror.js'));
check(
  () => assert.match(mirror, /d\.device !== window\.beadcause\?\.presence\?\.device/),
  'the pane still drops its own device from the list it follows'
);
check(
  () => assert.match(mirror, /presence\?\.report\(\{ view: state\.active \? null : 'sessions' \}\)/),
  'and still reports no view at all while it is the pane showing'
);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
