/**
 * The extensionless URLs the app answers to, read back out of `serveStatic`.
 *
 *     import { pageAliases, aliasPage } from './pagealias.js';
 *     const aliases = pageAliases();
 *     aliasPage('/advocates', aliases);   // '/monitor.html'
 *
 * Pages get renamed and merged and the shortcuts people already made do not, so a view
 * here answers to several paths — `/monitor`, `/advocates`, `/sessions`, `/work`,
 * `/work.html`, `/prs`, `/pulls` and `/prs.html` are by now one page. That mapping lives
 * in a run of one-line `if`s in `serveStatic` (lib/server.js), each with the paragraph
 * that says why its path is worth keeping, and it belongs there: the argument for a path
 * is the only thing that lets anybody tell later whether it may be dropped.
 *
 * **What needed it somewhere else was the check fixtures.** Every `scripts/*-check.mjs`
 * serves `public/` from a plain static handler of its own, and the page it serves
 * registers the real service worker, whose install precaches `SHELL` with one
 * all-or-nothing `caches.addAll`. Every extensionless entry in that list is an alias with
 * no file behind it, so all of them 404d in every fixture, the install rejected whole,
 * and `public/report.js` did exactly its job and posted the failure to `/api/error`. Two
 * checks count every POST to assert that a screen wrote nothing; those two went red, on a
 * page nobody had changed, with failure text pointing at the app (bc-zjep).
 *
 * So this derives the table rather than restating it, the way `routeTable` derives the
 * route list from the text of the handler. A fixture that hand-copied the list would be
 * right on the day it was written and wrong the first time a page gained a name — wrong
 * in the silent direction, because a 404 inside a service worker install is invisible
 * from the page it happened on. Nothing here reads a server: it is a regex over source
 * text, so a check can build the table before it has started anything at all.
 *
 * `test/pagealias.mjs` holds it against the real `lib/server.js` and against `SHELL`, and
 * is what turns a reformat of those `if`s from a silent 404 into a failing suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The source the two readers below parse, by default the one this repo runs. */
export const serverSource = () => fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');

/**
 * `{ '/advocates': '/monitor.html', … }` — every path `serveStatic` rewrites onto a page.
 *
 * Both shapes the run is written in: the one-liner, and the braced form the endorsement
 * queue's three paths outgrew. A condition is a chain of `urlPath === '…'` and every arm
 * of it lands on the same file, which is what makes the whole of it one flat table.
 */
export function pageAliases(src = serverSource()) {
  const table = {};
  for (const m of src.matchAll(/if \(([^)]*urlPath === '[^)]*)\)\s*\{?\s*urlPath = '([^']+)';/g)) {
    for (const p of m[1].matchAll(/urlPath === '([^']+)'/g)) table[p[1]] = m[2];
  }
  return table;
}

/**
 * The paths that answer with a **hop** rather than a document — a different thing to know
 * about a URL, and the reason they are not rows in the table above.
 *
 * `Cache.put` refuses a redirected response outright and the shell is installed
 * all-or-nothing, so one redirect path in `SHELL` means nothing at all is cached, on every
 * installed phone, for as long as that worker lives. `/closed` and `/done` are left out of
 * it deliberately and there is a long comment beside `/history` in public/sw.js saying so;
 * this is what lets a suite assert that rather than trust it.
 */
export function pageRedirects(src = serverSource()) {
  const out = [];
  for (const m of src.matchAll(/if \(([^)]*urlPath === '[^)]*)\)\s*\{[^}]*return redirect\(/g)) {
    for (const p of m[1].matchAll(/urlPath === '([^']+)'/g)) out.push(p[1]);
  }
  return out;
}

/** One URL as the file it serves — `/` included, which is the one alias not written as one. */
export function aliasPage(urlPath, aliases) {
  const served = aliases[urlPath] || urlPath;
  return served === '/' ? '/index.html' : served;
}
