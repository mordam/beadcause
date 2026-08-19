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
import { aliasPage, pageAliases, pageRedirects, serverSource, viewHops } from '../lib/pagealias.js';
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
const swSource = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const shell = shellPaths(swSource);

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

/* --------------------------------------------------- the worker answers the same hops */

/*
  The third list, and the newest (bc-khoe.30.7).

  Every view is a pane of one document now, so `/history` is a 302 to `/#history` rather
  than a page. `public/sw.js` has to be able to answer that hop **itself**: those paths
  cannot be in `SHELL` (see the check above — `Cache.put` refuses a redirect), so with no
  daemon to ask, a request for one of them misses the cache twice and falls through to the
  index page, which is the shell served under the old path with an empty hash. Home,
  whatever was tapped, on the phone the aliases exist for.

  So `VIEW_HOPS` in that file holds the same table. Two lists in two files that have to
  agree, which is the thing this suite exists for — and the worker's half is the one that
  cannot report its own drift, because a wrong hash there is a pane that opens instead of
  the one you asked for, offline, and looks exactly like a mis-tap.
*/
const workerHops = () => {
  const table = swSource.match(/const VIEW_HOPS = \{([\s\S]*?)\n\};/);
  const out = {};
  if (!table) return out;
  for (const m of table[1].matchAll(/'(\/[^']*)':\s*\{\s*view: '([a-z]+)'([^}]*)\}/g)) {
    out[m[1]] = { view: m[2], narrow: [...m[3].matchAll(/\['([^']+)', '([^']+)'\]/g)].map((n) => [n[1], n[2]]) };
  }
  return out;
};

check(() => {
  const daemon = viewHops(src);
  assert.ok(Object.keys(daemon).length > 1, 'no view hops parsed out of lib/server.js — the parse, not the list');
  assert.deepEqual(
    workerHops(),
    daemon,
    'public/sw.js answers a different view than lib/server.js does, so the same shortcut opens ' +
      'one pane online and another offline'
  );
}, "the worker's VIEW_HOPS is the daemon's own table, view for view");

/* And that every one of them is a redirect on the daemon rather than an alias — the case
   this cannot be allowed to slide back into. A `viewHop` line rewritten as
   `urlPath = '/index.html'` would serve the shell at the old path with no hash: the right
   document, the wrong view, and 200 rather than anything that reads as wrong. */
check(() => {
  const hops = pageRedirects(src);
  const notHops = Object.keys(viewHops(src)).filter((p) => !hops.includes(p));
  assert.deepEqual(notHops, [], `a view path that is not a redirect serves the shell with no hash: ${notHops.join(', ')}`);
}, 'and every path that names a view is a hop, never a rewrite');

/* ---------------------------------------- a pane that has landed owes its own addresses */

/*
  The forcing function, and the reason the rest of this epic cannot land half-done.

  A view is a document until its pane is filled and a hop afterwards, and those are two
  edits in two files that have to happen in the same commit. Miss the flip and the
  addresses go on serving a page that is no longer maintained — the pill shows the pane,
  a home-screen shortcut shows the document, and neither says the other exists. Make the
  flip too early and the hop lands on a `data-pending` container, which `public/panes.js`
  answers by showing Home: the ledger and the console unreachable from the phone, which
  is the outcome `data-pending` was invented to prevent.

  So the state of the container decides, and it is read from the three files that already
  hold the answer rather than from a list here: `public/index.html` says which panes are
  filled, `public/hashroute.js` says which addresses name which view, and `serveStatic`
  says which of them hop. Home is left out — its paths are `/` and `/index.html`, which
  serve the shell itself and can never be a hop to it.
*/
const paneState = () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const state = new Map();
  for (const m of html.matchAll(/<div class="pane" data-pane="([a-z]+)"([^>]*)>/g)) {
    state.set(m[1], /data-pending=/.test(m[2]) ? 'pending' : 'live');
  }
  return state;
};

const viewPaths = () => {
  const grammar = fs.readFileSync(path.join(PUBLIC, 'hashroute.js'), 'utf8');
  const out = new Map();
  for (const m of grammar.matchAll(/id: '([a-z]+)',[\s\S]{0,400}?paths: \[([^\]]*)\]/g)) {
    out.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((q) => q[1]));
  }
  return out;
};

check(() => {
  const panes = paneState();
  const paths = viewPaths();
  const hops = viewHops(src);
  assert.ok(panes.size > 2 && paths.size > 2, 'the panes or the view table did not parse — the readers, not the lists');

  const owed = [];
  const early = [];
  for (const [view, state] of panes) {
    if (view === 'epics') continue;
    for (const one of paths.get(view) || []) {
      const hopped = hops[one]?.view === view;
      if (state === 'live' && !hopped) owed.push(one);
      if (state === 'pending' && hopped) early.push(one);
    }
  }
  assert.deepEqual(
    owed,
    [],
    `a pane is filled and its addresses still serve the document it replaced: ${owed.join(', ')} — ` +
      'each owes three edits in one commit: a `return redirect(res, viewHop(…))` in serveStatic, ' +
      'the same path out of SHELL and into VIEW_HOPS in public/sw.js, and its row moved from ' +
      'PAGES to REDIRECTS in test/pagepaths.mjs'
  );
  assert.deepEqual(
    early,
    [],
    `a path hops to a pane that is still data-pending, which panes.js answers by showing Home: ${early.join(', ')}`
  );
}, 'a view whose pane has landed answers with a hop, and one still pending does not');

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
  assert.deepEqual(viewHops('const x = 1;\n'), {});
}, 'and a source with neither yields neither — the parser invents nothing');

/* And the view reader against a synthetic source of its own, both shapes: a bare hop and
   one the door narrows for itself. A `viewHops` that came back empty would make the
   agreement check above pass by comparing nothing with nothing. */
check(() => {
  const fake = [
    "    if (urlPath === '/one' || urlPath === '/one.html') {",
    "      return redirect(res, viewHop('uno', url));",
    '    }',
    "    if (urlPath === '/shut') {",
    "      return redirect(res, viewHop('uno', url, [['status', 'closed']]));",
    '    }',
    "    if (urlPath === '/hop') {",
    "      return redirect(res, '/one');",
    '    }',
  ].join('\n');
  assert.deepEqual(viewHops(fake), {
    '/one': { view: 'uno', narrow: [] },
    '/one.html': { view: 'uno', narrow: [] },
    '/shut': { view: 'uno', narrow: [['status', 'closed']] },
  });
  assert.ok(pageRedirects(fake).includes('/hop'), 'a hop onto a page is still a hop, and is not a view');
}, 'a view hop is read with its view and its narrowing, and a plain hop is not read as one');

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
