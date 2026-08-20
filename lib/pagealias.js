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
 *
 * `viewHops` at the foot is the third reader and the newest (bc-khoe.30.7): the subset of
 * those hops that land on a **view** of the shell rather than on a page, with the view
 * each one names. It exists because `public/sw.js` has to answer the same paths with the
 * same hops when there is no daemon to ask, and a worker holding a hand-copied list would
 * be right on the day it was written and wrong the first time a view moved.
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

/**
 * The hops that land on a **view of the shell**, as `{ '/history': { view, narrow } }`.
 *
 * A subset of `pageRedirects` above, and the difference is the far end: `/closed` and
 * `/history` both answer with a 302, but only because `serveStatic` calls `viewHop` do we
 * know the address they land on is `/#history` rather than a page. That is the fact
 * `public/sw.js` needs — it answers these same paths itself with no daemon to ask, and
 * `Response.redirect` there has to name the same view this does.
 *
 * `narrow` is what the door decides for itself, as pairs: `/closed` is the ledger with
 * `status=closed` on it whatever arrived. Everything else on the incoming URL is the
 * caller's and is split by `viewHop` at request time, which is not a thing that can be
 * read out of source and does not need to be — both ends do it the same way, and
 * test/pagepaths.mjs asserts the split against a running server.
 */
export function viewHops(src = serverSource()) {
  const out = {};
  // `[^{}]*?` rather than `\s*`: a hop asks `hopGate` before it answers (bc-khoe.30.7), so
  // the `return` is no longer the first statement in the block. Braces are what bounds it —
  // without them this would run on past a braced *alias* like `/endorse`'s and read the
  // next hop's view as that one's.
  const block = /if \(([^)]*urlPath === '[^)]*)\)\s*\{[^{}]*?return redirect\(res, viewHop\('([a-z]+)', url([^;]*)\);/g;
  for (const m of src.matchAll(block)) {
    const narrow = [...m[3].matchAll(/\['([^']+)', '([^']+)'\]/g)].map((n) => [n[1], n[2]]);
    for (const p of m[1].matchAll(/urlPath === '([^']+)'/g)) out[p[1]] = { view: m[2], narrow };
  }
  return out;
}

/**
 * What the daemon reads off a query string, and so the half that stays in front of the
 * `#`. The same set is `DAEMON_QUERY` in lib/server.js and in public/sw.js; a fragment is
 * never sent to a server, so a pairing token swept behind the hash is a token nothing can
 * read and the navigation after the hop is a login screen.
 */
const DAEMON_QUERY = new Set(['t']);

/**
 * The `Location` one of those hops answers with, or `null` if this path is not one.
 *
 * Here rather than in each `scripts/*-check.mjs` because those fixtures serve `public/`
 * from a static handler of their own and a path that has stopped being a *file* is a 404
 * in every one of them at once — which is the same failure bc-zjep cost two sessions to
 * find, arriving by the door bc-khoe.30.7 opened. They already derive the alias table from
 * this file rather than restating it; this is the other half of that table.
 *
 * The split is `viewHop`'s, in lib/server.js, and `viewAddress`'s in public/sw.js — a
 * third writing of two lines, and the reason it is tolerable is that test/pagealias.mjs
 * holds this one against a fixture of the real thing.
 */
export function hopLocation(urlPath, search, hops) {
  const hop = hops[urlPath];
  if (!hop) return null;
  const kept = new URLSearchParams();
  const filters = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search || '')) (DAEMON_QUERY.has(k) ? kept : filters).append(k, v);
  for (const [k, v] of hop.narrow || []) filters.set(k, v);
  const s = kept.toString();
  const q = filters.toString();
  return `/${s ? `?${s}` : ''}#${hop.view}${q ? `?${q}` : ''}`;
}

/** One URL as the file it serves — `/` included, which is the one alias not written as one. */
export function aliasPage(urlPath, aliases) {
  const served = aliases[urlPath] || urlPath;
  return served === '/' ? '/index.html' : served;
}
