#!/usr/bin/env node
//
// Every path the service worker precaches is a path something can serve.
//
//   npm test
//   node test/pagealias.mjs
//
// `public/sw.js` installs its `SHELL` with one `caches.addAll`, which is all-or-nothing:
// a single entry that 404s rejects the whole install and the app caches nothing at all.
// The extensionless entries in it — `/monitor`, `/prs`, `/archive` — have no file behind
// them at all, and the only thing that answers for them is a run of one-line `if`s in
// `serveStatic` (lib/server.js). Two lists, in two files, that have to agree, and neither
// of them says so.
//
// They disagreed everywhere but in the daemon. Every `scripts/*-check.mjs` serves
// `public/` from a static handler of its own that knew nothing about the aliases, so the
// install rejected in every check, `public/report.js` posted the failure to `/api/error`
// like it was built to, and the two checks that count every POST to prove a screen wrote
// nothing went red on their own fixture (bc-zjep). The failure text said "nothing was
// written — ["/api/error"]", which reads as the app writing to the tracker, and it cost
// two sessions before anybody dumped the body.
//
// The fixtures share the daemon's table now, derived from its source by `lib/pagealias.js`
// rather than copied. This is the suite that keeps the derivation honest — a reformat of
// those `if`s that the regex stops matching is otherwise silent twice over, first in the
// fixtures and then in a precache nobody watches. Pure text, no server and no Chrome, so
// it costs milliseconds and runs in `npm test` where the browser checks cannot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasPage, pageAliases, pageRedirects, serverSource } from '../lib/pagealias.js';
import { shellPaths } from '../lib/swbump.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');

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

console.log('\npage aliases\n');

const src = serverSource();
const aliases = pageAliases(src);
const shell = shellPaths(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8'));

/* ------------------------------------------------------- the table is really there */

/* The failure a derived table has that a copied one does not: a regex that matches
   nothing returns an empty object and every caller carries on serving 404s. So the count
   is asserted before anything is asserted with it — not a number this repo has to keep up
   to date, a floor that says the parse happened. */
check(() => {
  assert.ok(Object.keys(aliases).length > 10, `only ${Object.keys(aliases).length} aliases parsed out of lib/server.js`);
}, 'the alias table parses out of lib/server.js at all');

/* One of each shape the run is written in, because they are two different regex paths:
   the one-liner, and the braced form the endorsement queue's three paths outgrew. */
check(() => {
  assert.equal(aliases['/advocates'], '/monitor.html');
  assert.equal(aliases['/work.html'], '/monitor.html', 'the alias with no file behind it is the one that matters most');
}, 'the one-line form is read — /advocates and /work.html reach the console');
check(() => {
  assert.equal(aliases['/queue'], '/endorse.html');
  assert.equal(aliases['/endorsements'], '/endorse.html');
}, 'and the braced form with it — the endorsement queue answers to all of its names');

/* `/` is the one alias nobody wrote as one: it is `urlPath === '/' ? 'index.html'` at the
   foot of the run, and a fixture that resolved it to the empty string would serve a
   directory listing or a 404 for the page every check opens first. */
check(() => {
  assert.equal(aliasPage('/', aliases), '/index.html');
  assert.equal(aliasPage('/app.js', aliases), '/app.js', 'a path with a file behind it must come back untouched');
}, 'and / resolves to index.html, while an ordinary asset is left alone');

/* ------------------------------------------------------------- against SHELL itself */

check(() => {
  assert.ok(shell.length > 20, `only ${shell.length} paths read out of SHELL — the parse, not the list`);
}, 'SHELL parses out of public/sw.js');

/* The assertion this file exists for. Every shell entry, through the daemon's table, must
   land on a file that is on disk — which is what "the install does not reject" means, in
   the daemon and in every check fixture that serves public/ the same way. */
check(() => {
  const missing = shell.filter((p) => !fs.existsSync(path.join(PUBLIC, aliasPage(p, aliases).replace(/^\/+/, ''))));
  assert.deepEqual(
    missing,
    [],
    `precached with nothing to serve them, so caches.addAll rejects whole: ${missing.join(', ')}`
  );
}, 'every path in SHELL resolves to a file in public/');

/* And the other way a shell entry poisons the install, which is worse because it survives
   a page that exists: `Cache.put` refuses a redirected response outright. `/closed` and
   `/done` are kept out of SHELL on purpose and public/sw.js says so at length beside
   `/history`; this is what stops that comment being the only thing holding it. */
check(() => {
  const hops = pageRedirects(src).filter((p) => shell.includes(p));
  assert.deepEqual(hops, [], `Cache.put refuses a redirect, so the whole install rejects: ${hops.join(', ')}`);
}, 'and no path in SHELL is a redirect');

/* ------------------------------------------------------------------------ controls */

/* Both directions against synthetic sources, for the reason test/checks.mjs has controls:
   "the table looks fine" is the same output whether the parse works or the parser is
   broken, and the broken one is the more likely of the two to go unnoticed, because it is
   green everywhere except a service worker install nobody is watching. */
check(() => {
  const fake = [
    "    if (urlPath === '/one') urlPath = '/one.html';",
    "    if (urlPath === '/two' || urlPath === '/three') {",
    "      urlPath = '/two.html';",
    '    }',
    "    if (urlPath === '/hop') {",
    "      return redirect(res, '/two');",
    '    }',
  ].join('\n');
  assert.deepEqual(pageAliases(fake), { '/one': '/one.html', '/two': '/two.html', '/three': '/two.html' });
  assert.deepEqual(pageRedirects(fake), ['/hop'], 'a hop must not be read as an alias onto a page');
}, 'a source with both shapes and a hop in it is read as three aliases and one redirect');

check(() => {
  assert.deepEqual(pageAliases('const x = 1;\n'), {}, 'a source with no run of ifs cannot yield aliases');
  assert.deepEqual(pageRedirects('const x = 1;\n'), []);
}, 'and a source with neither yields neither — the parser invents nothing');

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
