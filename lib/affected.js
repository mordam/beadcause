/**
 * Given a diff, name the suites that actually cover it — `bin/b7e-affected` is the argv
 * shell; this is the matching.
 *
 * bc-khoe.40 names eight sessions (`bc-khoe.23`, `bc-khoe.27.1`, `bc-36xx.6`, `bc-5k22`,
 * `bc-xl7n.74`, `bc-xl7n.71`, `bc-1kwl.22`, `bc-j52g`) that each hand-wrote a grep to
 * answer "what do I need to run before the full gate finishes" — some against
 * identifiers, some against file paths, one against both in two separate passes — and no
 * two agreed on which files to grep or what counted as a hit. This is the one answer,
 * and it is three separable questions, not one:
 *
 * ## Three ways a suite depends on a file, and only one of them is `import`
 *
 * **It imports it**, statically or dynamically, directly or through a chain of other
 * `lib/` files — `test/inmain.mjs` never mentions `advocate.js` as a bare identifier, but
 * it does `await import(LIB('advocate.js'))`, and `LIB` is a same-file convention
 * (`const LIB = (f) => path.join(HERE, '..', 'lib', f)`) this file resolves rather than
 * requiring the caller to spell out. `test/filter.mjs` never imports `lib/advocate.js` at
 * all, but it imports `lib/server.js`, which does — so the edge is real two hops out, and
 * a graph that only looked at direct imports would miss it exactly the way `grep -l` did.
 *
 * **It reads the file's own source text**, not as a module but as a string. `public/
 * spacebar.js` is loaded into a browser by a `<script>` tag, never by an ESM `import` —
 * nothing in `test/` or `scripts/` ever resolves it as a module, so an import graph alone
 * would call it untested from everywhere. What actually covers it is
 * `test/editfreeze.mjs` and `test/sweepfail.mjs`, both of which do
 * `fs.readFileSync(path.join(ROOT, 'public', 'spacebar.js'))` (or a same-file `read('public/
 * spacebar.js')` wrapper around it) and assert on what the text says. That is a
 * dependency with no `import` anywhere near it.
 *
 * **It names the file in a string, without reading it, in its own source.** A check
 * under `scripts/*-check.mjs` names a page by its bare filename (`file: 'monitor.html'`)
 * in the `PAGES`/`ROUTES` tables `viewbar-check.mjs` and `lib/server.js` both carry — no
 * read, no import, just the name, and the check's own file is where the name has to be
 * for this to see it (see "one hop, never further" below).
 *
 * `--why` reports which of the three (or, for a check naming a page, the sharper "serves
 * this page") is why a suite showed up, because the three cost different amounts of
 * confidence: an import is certain, a source-text read is a search that could in
 * principle be a coincidence, and a bare name is the weakest of the three and the one
 * most likely to be a false alarm. None of that changes what gets run — `b7e-gate` does
 * not care why a suite is on the list — but it is the difference between trusting the
 * list and re-deriving it by hand anyway.
 *
 * ## Comments are stripped, and a text match is one hop, never further
 *
 * `lib/checkaudit.js` strips comments before it goes looking for a selector, because a
 * class named in a header's prose is not a class the code presses — the exact same
 * argument applies here in the opposite direction. Nearly every file in this repo's
 * headers cross-references other files by path in plain prose (`lib/container.js`'s own
 * header says "`batchesFor` (lib/advocate.js)"), and picking that up as a real reference
 * would make almost every file "name" almost every other one.
 *
 * That is not hypothetical, and it is why a text match is checked against a suite's *own*
 * source only, never against something the suite merely imports (`findAffected`'s own
 * docstring below has the number: propagated one hop through the import graph, a single
 * line in `lib/foundation.js` — imported by nearly everything — turned `lib/advocate.js`
 * into 222 of 449 "affected" suites, which is worse than useless). The cost is real and
 * known rather than invisible: `bc-xl7n.74`'s hand-added list for `lib/advocate.js` named
 * six suites domain knowledge could reach that a text search bounded this way cannot.
 * Three come back anyway, because they turn out to genuinely import `lib/advocate.js`
 * transitively (`test/superseded.mjs`, `test/inmain.mjs`, and `test/filter.mjs` two hops
 * out through `lib/server.js`). Three do not: `test/container.mjs` (the only trace is
 * `lib/container.js`'s header prose), `test/notinmain.mjs`, and `test/evidence.mjs` —
 * whose `lib/evidence.js` does carry a real, code, non-comment `writers: ['lib/
 * advocate.js']` line, one hop further out than a suite-direct check reaches. What it
 * does find — every suite that imports `lib/advocate.js` transitively, plus whichever
 * suites carry a direct text trace of their own — is a strictly cheaper, strictly more
 * honest floor than the whole test directory, which is what this replaces.
 *
 * ## Never a shrug
 *
 * A changed file with no source-level trace anywhere in `bin/`, `lib/`, `public/`,
 * `scripts/` or `test/` is reported as unmatched, not silently absent from the list —
 * `bc-khoe.40`'s acceptance is explicit that returning nothing here must read as "run the
 * full gate", never as "nothing covers this". `bin/b7e-affected` is what turns that into
 * an empty stdout (so a caller piping into `b7e-gate --only` gets no narrowing at all,
 * which is `b7e-gate`'s own definition of "everything") plus a loud stderr line, rather
 * than quietly narrowing around a file this file could not place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverSuites } from './gate.js';
import { discover as discoverChecks, stripComments } from './checkaudit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This repo's own root — same anchor `lib/gate.js` uses. */
export const REPO_ROOT = path.join(HERE, '..');

/** Every directory this repo's own code lives in — the whole graph is built from these. */
export const SOURCE_DIRS = ['bin', 'lib', 'public', 'scripts', 'test'];
const JS_EXT_RE = /\.(mjs|cjs|js)$/;
const ASSET_EXT_RE = /\.(html|css)$/;

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function walk(dir, matches, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, matches, out);
    else if (matches.test(e.name)) out.push(full);
  }
}

/** Every JS-ish file under the source dirs, repo-relative, forward-slashed, sorted. */
export function listJsFiles(root) {
  const out = [];
  for (const d of SOURCE_DIRS) walk(path.join(root, d), JS_EXT_RE, out);
  return out.map((f) => toRel(root, f)).sort();
}

/** Every `.html`/`.css` file under `public/`, repo-relative, forward-slashed, sorted. */
export function listAssetFiles(root) {
  const out = [];
  walk(path.join(root, 'public'), ASSET_EXT_RE, out);
  return out.map((f) => toRel(root, f)).sort();
}

/**
 * The universe of suite paths a match can be reported against: `npm test`'s own list
 * (`lib/gate.js`'s `discoverSuites`, which shells out to `scripts/test.mjs --list` —
 * `test/*.mjs` plus the two pinned `scripts/` entries) union every browser check under
 * `scripts/*-check.mjs` (`lib/checkaudit.js`'s `discover`, the same inventory `npm run
 * checks` runs). Two existing inventories, not a third written here.
 */
export function candidateSuites(root) {
  return [...new Set([...discoverSuites(root), ...discoverChecks(root)])].sort();
}

/* ------------------------------------------------------------------- reading, cached */

/** `{ raw, stripped }` for a file, read and comment-stripped once per root per file. */
function makeSourceCache(root) {
  const cache = new Map();
  return (relFile) => {
    if (cache.has(relFile)) return cache.get(relFile);
    let raw = null;
    try {
      raw = fs.readFileSync(path.join(root, relFile), 'utf8');
    } catch {
      raw = null;
    }
    const entry = raw == null ? null : { raw, stripped: stripComments(raw) };
    cache.set(relFile, entry);
    return entry;
  };
}

/* ------------------------------------------------------------------------- imports */

/**
 * `const LIB = (f) => path.join(HERE, '..', 'lib', f)` and its `PUBLIC` sibling are the
 * one dynamic-import convention this repo actually uses (checked against every `test/*`
 * and `scripts/*` file: only these two names, always resolving to `lib/` or `public/`
 * regardless of whether the base is `HERE` or `ROOT`) — so rather than hardcode the two
 * names, this finds *any* same-file helper of that shape and reads which of the five
 * source dirs its `path.join` mentions literally.
 */
const HELPER_DEF_RE = /\bconst\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\(\s*[\w]+\s*\)\s*=>\s*path\.join\(([^)]*)\)/g;

function localHelperDirs(stripped) {
  const dirs = {};
  HELPER_DEF_RE.lastIndex = 0;
  let m;
  while ((m = HELPER_DEF_RE.exec(stripped))) {
    const [, name, args] = m;
    for (const dir of SOURCE_DIRS) {
      if (new RegExp(`['"\`]${dir}['"\`]`).test(args)) {
        dirs[name] = dir;
        break;
      }
    }
  }
  return dirs;
}

// `import x from 'y'`, `import {a,b} from 'y'`, `export {a} from 'y'`, `export * from 'y'` —
// bounded at the first `;` so a non-greedy scan across a multi-line destructure cannot run
// past the statement it belongs to and latch onto an unrelated `from '...'` far later.
const FROM_IMPORT_RE = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;
// `import './x.js'` — a side-effect import with no `from`.
const BARE_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
// `import(LIB('x.js'))`, `require(PUBLIC('x.html'))` — the helper form, resolved via
// `localHelperDirs` above rather than assumed to be `LIB`/`PUBLIC` by name.
const HELPER_CALL_RE = /\b(?:import|require)\(\s*([A-Z][A-Za-z0-9_]*)\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
const DYNAMIC_LITERAL_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every file this one resolves to, repo-relative, forward-slashed — relative specifiers
 * resolved against the importing file's own directory, helper-call specifiers resolved
 * against the repo root via `localHelperDirs`. Bare package specifiers (`'yaml'`,
 * `'node:fs'`) and anything that does not resolve to a file on disk are dropped: this is
 * a graph of *this repo's* files, not a dependency list.
 */
export function parseImports(root, relFile, stripped) {
  const dir = path.dirname(path.join(root, relFile));
  const helperDirs = localHelperDirs(stripped);
  const specs = new Set();
  for (const re of [FROM_IMPORT_RE, BARE_IMPORT_RE, REQUIRE_RE, DYNAMIC_LITERAL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) specs.add(m[1]);
  }
  const helperSpecs = [];
  HELPER_CALL_RE.lastIndex = 0;
  let hm;
  while ((hm = HELPER_CALL_RE.exec(stripped))) helperSpecs.push([hm[1], hm[2]]);

  const resolved = new Set();
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue; // bare package specifier — not this repo's graph
    const abs = path.join(dir, spec);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) resolved.add(toRel(root, abs));
  }
  for (const [name, arg] of helperSpecs) {
    const d = helperDirs[name];
    if (!d) continue;
    const abs = path.join(root, d, arg);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) resolved.add(toRel(root, abs));
  }
  return [...resolved];
}

/** `{ forward: Map<file, Set<file>> }` over every JS-ish file under the source dirs. */
export function buildGraph(root, sourceOf) {
  const read = sourceOf || makeSourceCache(root);
  const forward = new Map();
  for (const file of listJsFiles(root)) {
    const entry = read(file);
    forward.set(file, new Set(entry ? parseImports(root, file, entry.stripped) : []));
  }
  return { forward, sourceOf: read };
}

/** `file` plus everything it imports, transitively — memoized per call to `findAffected`. */
function closureOf(forward, start, cache) {
  if (cache.has(start)) return cache.get(start);
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of forward.get(cur) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  cache.set(start, seen);
  return seen;
}

/* ---------------------------------------------------------------- exported identifiers */

const EXPORT_FN_RE = /\bexport\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_DECL_RE = /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_RE = /\bexport\s*\{([^}]*)\}/g;

/**
 * Distinctive exported names worth searching for elsewhere — `createAdvocates`,
 * `isContainer`. Short or generic names (`ok`, `run`, `id`) are dropped: an identifier
 * under six characters with no internal capital is exactly the kind of thing that would
 * turn "names it" into "contains a common English word", which is noise rather than a
 * finding. Nothing here requires a name to be *unique* in the repo, only distinctive
 * enough that its appearance elsewhere is worth a look.
 */
export function exportedNames(stripped) {
  const names = new Set();
  // camelCase/PascalCase compounds (an internal lower-then-upper transition) or
  // SCREAMING_SNAKE constants at least three characters long — not a bare length cutoff,
  // which is what let `options` (exported by lib/advocate.js, six characters, no internal
  // capital) through the first cut of this and turned "names it in a string" into "is an
  // ordinary English word", matching 247 suites for one changed file. The three-character
  // floor on the all-caps branch is the second cut of the same lesson: this file's own
  // test fixtures write `"export const A = 1;\n"` as a *string*, not code, to build a
  // fabricated source tree, and a single capital letter satisfies `[A-Z][A-Z0-9_]*` just
  // as well as a real constant — `A`, unlike `PROPOSAL_LABEL`, is a coincidence anywhere
  // it appears, and it appears constantly, as a variable name, a grade, a section letter.
  const add = (n) => {
    if (/[a-z][A-Z]/.test(n) || (/^[A-Z][A-Z0-9_]*$/.test(n) && n.length >= 3)) names.add(n);
  };
  for (const re of [EXPORT_FN_RE, EXPORT_DECL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) add(m[1]);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_LIST_RE.exec(stripped))) {
    for (let token of m[1].split(',')) {
      token = token.trim();
      if (!token) continue;
      const asMatch = token.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      add(asMatch ? asMatch[1] : token.split(/\s+/)[0]);
    }
  }
  return [...names];
}

/* --------------------------------------------------------------------- text references */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const READ_NEAR_RE = /readFileSync|readFile\s*\(|\bread\s*\(|\braw\s*\(/;

/** A window of source either side of `index`, for "is this literal near a read call". */
const window = (s, index, len, radius = 160) => s.slice(Math.max(0, index - radius), Math.min(s.length, index + len + radius));

/**
 * Does `stripped` contain `target`'s own path as a literal — a single quoted string
 * (`'public/spacebar.js'`, the `read()`-wrapper shape), the quoted segments of a
 * `path.join(...)` call joining to the same path (`path.join(ROOT, 'public',
 * 'spacebar.js')`, the `fs.readFileSync` shape), or — only when `target.bareBasenameOk`
 * — the bare filename alone (`'monitor.html'`), which is the convention every
 * `scripts/*-check.mjs` and `lib/server.js`'s own `PAGES`/`ROUTES` tables use for a page
 * they never read or import, just name. Bare-basename matching is deliberately not the
 * default: `'config.js'` or `'index.js'` alone would hit constantly and mean nothing:
 * confined to `public/*.html`/`*.css`, where this repo's one actual naming convention
 * lives, it costs nothing and finds what `--why`'s "serves this page" reason is for.
 * Returns the match index, or -1.
 */
function pathLiteralIndex(stripped, target) {
  const quoted = new RegExp(`['"\`]${escapeRe(target.rel)}['"\`]`);
  const direct = stripped.search(quoted);
  if (direct !== -1) return direct;

  if (target.bareBasenameOk) {
    const bare = stripped.search(new RegExp(`['"\`]${escapeRe(target.basename)}['"\`]`));
    if (bare !== -1) return bare;
  }

  const joinRe = /path\.join\(([^)]*)\)/g;
  let m;
  while ((m = joinRe.exec(stripped))) {
    const segs = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((s) => s[1]);
    if (segs.length && segs.join('/') === target.rel) return m.index;
  }
  return -1;
}

/**
 * How (if at all) `stripped` refers to `target` — `target` is `{ rel, basename, names,
 * bareBasenameOk }`. Returns `null`, or one of `'reads its source text'` / `'names it in
 * a string'`: a path literal within a couple hundred characters of a read call is the
 * former, anything else (a bare path literal with no read nearby, or a bare identifier)
 * is the latter.
 */
export function referenceReason(stripped, target) {
  const idx = pathLiteralIndex(stripped, target);
  if (idx !== -1) {
    return READ_NEAR_RE.test(window(stripped, idx, target.rel.length)) ? 'reads its source text' : 'names it in a string';
  }
  for (const name of target.names) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(stripped)) return 'names it in a string';
  }
  return null;
}

/* ------------------------------------------------------------------------- the answer */

/** `{ rel, names, isPublicPage }` for a changed file — read once, reused across every suite. */
function targetInfo(root, rel, sourceOf) {
  const entry = sourceOf(rel);
  const names = entry && JS_EXT_RE.test(rel) ? exportedNames(entry.stripped) : [];
  const isPublicAsset = rel.startsWith('public/') && ASSET_EXT_RE.test(rel);
  return {
    rel,
    basename: path.basename(rel),
    names,
    bareBasenameOk: isPublicAsset,
    isPublicPage: rel.startsWith('public/') && rel.endsWith('.html'),
  };
}

/**
 * The whole answer for one root and one list of changed (repo-relative) files:
 * `{ results: [{ file, matches: [{ suite, reasons: [...] }] }], unmatched: [file, ...] }`.
 *
 * `results` only carries files with at least one match; a file with none is in
 * `unmatched` instead, never silently absent from both — see the file header.
 *
 * **`imports it` is the only reason that travels through the transitive closure.** A
 * text reference does not: it is checked against each candidate suite's *own* source
 * only, never against something the suite merely imports. The first version of this
 * propagated a text match the same way an import does — "this file names the changed
 * one, and that file is in the suite's import closure" — and it was wrong in a way the
 * `advocate.js` acceptance case does not surface by itself, because it only asks for six
 * suites. `lib/foundation.js` carries `briefOwner: 'lib/advocate.js'` (a real, code,
 * non-comment reference — one line in an agent-brief registry) and is imported, directly
 * or not, by nearly every suite in the repo; propagated, that one line turned a change to
 * `lib/advocate.js` into 222 "affected" suites out of 449, which is worse than useless —
 * indistinguishable from the shrug this file exists to replace. `test/evidence.mjs` is
 * the one specific cost of not doing that: it reaches `lib/advocate.js` only through
 * `lib/evidence.js`'s `writers` array, one hop away, and this does not find it — the
 * same accepted-gap shape as `test/container.mjs` and `test/notinmain.mjs` in the file
 * header, not a new one.
 */
export function findAffected(root, changedFiles) {
  const sourceOf = makeSourceCache(root);
  const { forward } = buildGraph(root, sourceOf);
  const closureCache = new Map();
  const suites = candidateSuites(root);

  const results = [];
  const unmatched = [];

  for (const file of changedFiles) {
    const info = targetInfo(root, file, sourceOf);

    const matches = [];
    for (const suite of suites) {
      const closure = closureOf(forward, suite, closureCache);
      const reasons = new Set();
      if (closure.has(file)) reasons.add('imports it');
      const suiteEntry = sourceOf(suite);
      if (suiteEntry) {
        const reason = referenceReason(suiteEntry.stripped, info);
        if (reason) reasons.add(reason);
      }
      if (reasons.size && info.isPublicPage && suite.startsWith('scripts/') && suite.endsWith('-check.mjs')) {
        reasons.clear();
        reasons.add('serves this page');
      }
      if (reasons.size) matches.push({ suite, reasons: [...reasons] });
    }

    if (matches.length) results.push({ file, matches });
    else unmatched.push(file);
  }

  return { results, unmatched, suites: [...new Set(results.flatMap((r) => r.matches.map((m) => m.suite)))].sort() };
}

/* -------------------------------------------------------------------------- git diff */

function run(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolvableBase(root) {
  for (const cand of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', cand], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      return cand;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * With no explicit paths: `git diff --name-only $(git merge-base origin/main HEAD)...HEAD`
 * (falling back to `main` if `origin/main` does not resolve, which is how this is tested
 * against a fabricated repo with no remote) plus every uncommitted change — tracked
 * (`git diff --name-only HEAD`) and untracked (`git ls-files --others --exclude-standard`).
 */
export function defaultChangedFiles(root) {
  const files = new Set();
  const base = resolvableBase(root);
  if (base) {
    const mergeBase = run(root, ['merge-base', base, 'HEAD'])[0];
    if (mergeBase) for (const f of run(root, ['diff', '--name-only', `${mergeBase}...HEAD`])) files.add(f);
  }
  for (const f of run(root, ['diff', '--name-only', 'HEAD'])) files.add(f);
  for (const f of run(root, ['ls-files', '--others', '--exclude-standard'])) files.add(f);
  return [...files].sort();
}

/** A CLI-given path, relative to `cwd` or absolute, resolved to a repo-relative form. */
export function toRepoRel(root, cwd, given) {
  const abs = path.isAbsolute(given) ? given : path.resolve(cwd, given);
  return toRel(root, abs);
}
