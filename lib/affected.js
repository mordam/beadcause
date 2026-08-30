/**
 * Given a diff, name the suites that actually cover it — `bin/b7e-affected` is the argv
 * shell; this is the matching.
 *
 * bc-khoe.40 names eight sessions (`bc-khoe.23`, `bc-khoe.27.1`, `bc-36xx.6`, `bc-5k22`,
 * `bc-xl7n.74`, `bc-xl7n.71`, `bc-1kwl.22`, `bc-j52g`) that each hand-wrote a grep to
 * answer "what do I need to run before the full gate finishes" — some against
 * identifiers, some against file paths, one against both in two separate passes — and no
 * two agreed on which files to grep or what counted as a hit. This is the one answer,
 * and it is five separable questions, not one:
 *
 * ## Five ways a suite depends on a file, and only one of them is `import`
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
 * **It shares the file's name.** `test/panestage.mjs` is the suite for
 * `public/panestage.js`, and until bc-xlz32.9 nothing here knew that: the page is loaded
 * by a `<script>` tag so there is no import, and the suite reaches it through the browser
 * rather than by reading it, so `public/panestage.js` came back *unmatched* — which,
 * because one unplaceable file empties `b7e-affected`'s stdout on purpose, meant the
 * whole 44-minute gate ran. Five of the last thirty merges to `main` fell back that way.
 * The pairing is a real convention rather than a guess (the numbers are on
 * `sameNameSuites` below), and it is the cheapest signal in the repo: no read, no parse,
 * just the stem.
 *
 * **It walks the directory the file is in**, and so covers files it could not possibly
 * name — including ones that did not exist when it was written. `test/dashprompt.mjs`
 * reads every entry of `lib/` and asserts none of them passes a prompt to `claude`
 * unguarded; `test/checks.mjs` does the same over `scripts/`. Thirteen suites in this
 * repo are this shape, and they are the ones that catch "a new file arrived without a
 * header" — precisely what narrowing on names and imports is blind to, because there is
 * nothing to name. This is the one gap that would make a narrowed gate *wrong* rather
 * than merely slow, which is why `walkedDirs` computes it from the suite's own source
 * instead of keeping a list somebody has to remember to add to.
 *
 * `--why` reports which of the five (or, for a check naming a page, the sharper "serves
 * this page") is why a suite showed up, because they cost different amounts of
 * confidence: an import is certain, a source-text read is a search that could in
 * principle be a coincidence, and a bare name or a shared stem is weakest and the most
 * likely to be a false alarm. None of that changes what gets run — `b7e-gate` does
 * not care why a suite is on the list — but it is the difference between trusting the
 * list and re-deriving it by hand anyway.
 *
 * A shared stem is still a *match*, and deliberately so: it suppresses the unmatched
 * warning the same way the other three do. The alternative — count it in the list but
 * still shrug to the full gate — spends 44 minutes to hedge against a coincidence whose
 * worst case is one extra suite of a median 0.9 seconds. `public/config.js` matching
 * `test/config.mjs`, which is really about `lib/config.js`, is exactly that worst case,
 * and it is the cheap direction to be wrong in.
 *
 * ## A manifest is data, and an import edge does not propagate out of one
 *
 * `lib/toolbelt.js` is one array of tool names and a string joined from it. Nothing
 * imports it for behaviour — `lib/agents.js` and `lib/foundation.js` import it for the
 * *list*, and nearly every suite in the repo reaches one of those two. So adding a b7e
 * tool, which is a one-line edit to that array and the single most common diff shape in
 * this repo, used to select **205 suites**: 196 of them for no better reason than
 * `imports it`. Measured over the last forty merges to `main`, that one file is why a
 * narrowed gate cost a median 30% of the full suite instead of 2% (bc-xlz32.7).
 *
 * A file may therefore declare `@manifest` in its own header, and an `imports it` edge
 * does not propagate *from* it. The other three reasons still do: a suite that asserts
 * on the list names `DEFAULT_TOOL_LIST`, `DEFAULT_TOOLS`, or `toolbelt.js` itself, and
 * every one of those is a text match against the suite's own source. What is genuinely
 * given up is a suite that consumes the list at one remove — through
 * `lib/foundation.js`'s `allowedTools`, say — and names nothing. That suite runs at the
 * gate, which is where `merge_group` and `push: main` still run all 530.
 *
 * The tag is not a courtesy. `manifestProblems` refuses it to any file that imports
 * something or declares a function, `findAffected` reports every file that claimed it
 * (`manifests`) so `b7e-affected` can say so out loud rather than narrowing quietly, and
 * `test/affected.mjs` runs the check over every `@manifest` file in the real repo. The
 * failure this guards against is a file with real behaviour in it wearing the tag to get
 * out of its own tests.
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

/**
 * `file` plus everything it imports, transitively — memoized per `cache` (a fresh `Map()`
 * per call to `findAffected`; a caller answering the module-graph question for several
 * starts over the same `forward` map, such as `lib/callers.js`'s `moduleReport`, can share
 * one `cache` across calls).
 */
export function closureOf(forward, start, cache) {
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

/**
 * The suite this repo's own naming convention would give `rel`, if there is one. Three
 * forms, all measured on 2026-08-26 rather than assumed:
 *
 * - `test/<stem>.mjs` — the ordinary one. 218 of 290 `lib/` files, 23 of 48
 *   `public/*.js`, 14 of 92 `bin/` entries.
 * - `test/<stem with dashes removed>.mjs` — how the `bin/b7e-*` family spells it
 *   (`bin/b7e-bound` → `test/b7ebound.mjs`). 26 further `bin/` entries, which is nearly
 *   twice as many as the plain form reaches there.
 * - `test/b7e<stem>.mjs` — a `lib/` module whose suite is named after the tool in front
 *   of it rather than after itself (`lib/precedent.js` → `test/b7eprecedent.mjs`). Seven
 *   `lib/` files are covered *only* this way and four are covered both ways; small, but
 *   it is the family that grows every time a b7e tool is added, and `lib/precedent.js`
 *   is one of the two files that still sent the last thirty merges to the full gate.
 *
 * Three rules rather than one tidy one because the repo has three conventions, not one.
 *
 * Nothing checks that the suite *exists*: `findAffected` only ever compares this against
 * the candidate list, so a stem with no suite behind it simply matches nothing.
 */
function sameNameSuites(rel) {
  const stem = path.parse(rel).name;
  return [...new Set([`test/${stem}.mjs`, `test/${stem.replace(/-/g, '')}.mjs`, `test/b7e${stem}.mjs`])];
}

/* -------------------------------------------------------------------- walking the tree */

// `readdirSync(path.join(ROOT, 'lib'))`, `readdir(new URL('../bin', ...))` — any read of a
// *directory* whose quoted segments name one of the source dirs. Bounded at the closing
// paren of the call so a later unrelated literal cannot be dragged in.
const READDIR_CALL_RE = /\breaddir(?:Sync)?\(([^)]*)\)/g;

/**
 * The source directories a suite reads as directories rather than as files — `bin`,
 * `lib`, `public`, `scripts`, `test`.
 *
 * This is the fifth way a suite can depend on a file and the only one that does not need
 * the file to exist yet: `test/checks.mjs` walks `scripts/` and asserts something about
 * every entry it finds, so it covers a file that was added five minutes ago and is named
 * nowhere. Ten suites in this repo do this — the convention checks, the ones that catch
 * "a new file arrived without a header" — and they are exactly the suites a matcher built
 * on names and imports cannot see, because there is nothing to name.
 *
 * Getting this wrong is the one way narrowing can be *silently* wrong rather than merely
 * slow, which is why it is computed rather than kept as a list somebody has to remember
 * to add to. The over-approximation — a suite that walks a fixture directory it happened
 * to call `lib` — costs one extra suite, and all ten of the real ones together cost 24
 * seconds of a 44-minute suite.
 */
export function walkedDirs(stripped) {
  const dirs = new Set();
  READDIR_CALL_RE.lastIndex = 0;
  let m;
  while ((m = READDIR_CALL_RE.exec(stripped))) {
    for (const [, seg] of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
      if (SOURCE_DIRS.includes(seg)) dirs.add(seg);
    }
  }
  return dirs;
}

/**
 * A file that declares itself a manifest, with `@manifest` in its own header (bc-xlz32.7).
 * It is looked for in the *raw* source, not the stripped one, precisely because it is a
 * claim made in prose about the file it sits in.
 *
 * `manifestProblems` below is what stops this from being a way to opt any inconvenient
 * file out of the gate, and `test/affected.mjs` runs it over the real repo.
 */
const MANIFEST_TAG_RE = /^[\s*/]*@manifest\b/m;
export const isManifestSource = (raw) => MANIFEST_TAG_RE.test(raw || '');

/**
 * Why `raw` may not call itself a manifest — `[]` if it may. A manifest is **data an
 * import edge should not propagate from**, and the two conditions are exactly what makes
 * that true: it imports nothing (so there is no chain of consequences beneath it), and it
 * declares no functions (so its consumers get values, not behaviour). A file that fails
 * either one and claims the tag is a file whose changes would go untested on every branch
 * that touches it, which is why this is a check and not a comment asking nicely.
 */
export function manifestProblems(raw) {
  const stripped = stripComments(raw || '');
  const problems = [];
  if (/\bimport\s+[^;]*from\s+['"]|\bimport\s*\(|\brequire\s*\(/.test(stripped)) problems.push('it imports something — a manifest is a leaf');
  if (/\bfunction\b|=>/.test(stripped)) problems.push('it declares a function — a manifest is data, not behaviour');
  return problems;
}

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
    topDir: rel.split('/')[0],
    sameName: sameNameSuites(rel),
    isManifest: !!entry && isManifestSource(entry.raw) && manifestProblems(entry.raw).length === 0,
  };
}

/**
 * The whole answer for one root and one list of changed (repo-relative) files:
 * `{ results: [{ file, matches: [{ suite, reasons: [...] }] }], unmatched: [file, ...],
 * manifests: [file, ...] }`.
 *
 * `manifests` is every changed file that declared `@manifest` and was allowed it — the
 * files whose `imports it` edges were deliberately not propagated. It is reported rather
 * than merely applied so a caller can say out loud why the list is short.
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
  const manifests = [];

  for (const file of changedFiles) {
    const info = targetInfo(root, file, sourceOf);
    if (info.isManifest) manifests.push(file);

    const matches = [];
    for (const suite of suites) {
      const closure = closureOf(forward, suite, closureCache);
      const reasons = new Set();
      // A manifest is data: importing it says nothing about caring what is in it, so the
      // one reason that travels the closure does not travel out of one. See `isManifest`.
      if (!info.isManifest && closure.has(file)) reasons.add('imports it');
      const suiteEntry = sourceOf(suite);
      if (suiteEntry) {
        const reason = referenceReason(suiteEntry.stripped, info);
        if (reason) reasons.add(reason);
      }
      // Last, because they are the weakest of the five and read that way in `--why`.
      if (info.sameName.includes(suite)) reasons.add('shares its name');
      if (suiteEntry && walkedDirs(suiteEntry.stripped).has(info.topDir)) reasons.add('walks the tree');
      if (reasons.size && info.isPublicPage && suite.startsWith('scripts/') && suite.endsWith('-check.mjs')) {
        reasons.clear();
        reasons.add('serves this page');
      }
      if (reasons.size) matches.push({ suite, reasons: [...reasons] });
    }

    // A walk is a reason to *run* a suite, not evidence that this file is covered: a
    // convention check reads every entry of `lib/` whether or not anyone has ever tested
    // the one that changed. So a file whose only matches are walks is still unmatched —
    // "never a shrug" is unchanged, and `b7e-affected` still empties stdout for it — but
    // when something else does cover the file, the walkers come along.
    const covering = matches.filter((m) => !(m.reasons.length === 1 && m.reasons[0] === 'walks the tree'));
    if (covering.length) results.push({ file, matches });
    else unmatched.push(file);
  }

  return { results, unmatched, manifests, suites: [...new Set(results.flatMap((r) => r.matches.map((m) => m.suite)))].sort() };
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
