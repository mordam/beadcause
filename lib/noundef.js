/**
 * The scope check nothing in this repo had: a name that resolves to no binding,
 * anywhere in `lib/`, `bin/` or `scripts/`.
 *
 * bc-gdub was `bus is not defined`, thrown out of `settleDeploys` in the live daemon,
 * days after the line that caused it merged. `bus` is a plain local of `createApp` —
 * correct three thousand lines up — and inside `startPoller`, further down the same
 * file, the same object is only reachable as `app.bus`. Nothing here catches that at
 * parse time (`node --check` only parses) and nothing catches it at boot: it fires the
 * first time the sweep that holds the bad line actually runs, which can be days later,
 * on a build nobody is looking at. Every guard this repo had before this file was
 * either a regex over the source — which cannot tell `bus` from `app.bus`, and did
 * not — or a suite that happens to execute the exact line. See test/pollerbus.mjs,
 * which pins this one function by name; this is the general version bc-gdub.1 asked
 * for, and pollerbus.mjs is kept because it also proves the sweep *runs*, which this
 * file deliberately does not attempt.
 *
 * The approach: parse each file with acorn and hand the AST to `eslint-scope` — the
 * same scope-resolution engine ESLint's own `no-undef` rule uses, not a hand-rolled
 * approximation — and read `globalScope.through`: every identifier reference that
 * resolved to no binding in the whole file. `catch` bindings, destructured
 * parameters, `for-of`/`for-in`, hoisted `var`/function declarations, block-scoped
 * `let`/`const`, classes, generators, `arguments` inside ordinary functions — all of
 * it is real scope analysis, not a guess about which of those forms this repo happens
 * to use.
 *
 * The one hand-written part is deciding what counts as a legitimate global, and it is
 * hand-written as little as possible: `runtimeGlobals()` reads
 * `Object.getOwnPropertyNames(globalThis)` from the *same* Node process this check
 * itself runs in — this repo is "type": "module" throughout, so that is exactly the
 * ambient environment every file in lib/, bin/ and scripts/ actually executes under.
 * No `require`, `module`, `__dirname` or bare module names (`fs`, `path`, …) appear in
 * it, because none of those exist as globals in real ESM — which is the point: a file
 * that referenced one of those bare would be just as broken as the `bus` line was, and
 * this catches it the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';

/** Where this check looks. Same three directories the bead named. */
export const SCAN_DIRS = ['lib', 'bin', 'scripts'];

// Latest is not a valid ecmaVersion for eslint-scope's `analyze` (acorn accepts
// 'latest'; eslint-scope wants a number, or leaves optional-syntax scopes unresolved
// if it does not recognise the number). Everything this repo's source actually uses —
// top-level await, class fields, optional chaining, `??`, dynamic `import()` — parses
// fine under 2022, and a suite that ran clean at 2022 stays clean at 2022 whatever
// Node version happens to run it.
const ECMA_VERSION = 2022;

/** Every `.js`/`.mjs` file under `dirs` (repo-relative), sorted. */
export function scanFiles(root, dirs = SCAN_DIRS) {
  const out = [];
  for (const dir of dirs) walk(path.join(root, dir), root, out);
  return out.sort();
}

function walk(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a named dir that does not exist is not this check's problem
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out);
    } else if (/\.m?js$/.test(entry.name)) {
      out.push(path.relative(root, full));
    }
  }
}

/**
 * The real, running environment's own global names — not a hand-typed guess that
 * goes stale the next time a Node release adds one. Cached: it does not change
 * within one process, and every file in a scan asks for it.
 */
let cachedGlobals = null;
export function runtimeGlobals() {
  if (!cachedGlobals) cachedGlobals = new Set(Object.getOwnPropertyNames(globalThis));
  return cachedGlobals;
}

/**
 * Every identifier reference in `source` that resolves to no binding: not declared
 * in the file, not a parameter, not imported, not a known global. Returns
 * `{name, line, column}` (1-based), sorted by position. A file that fails to parse
 * is reported as clean — a syntax error is `node --check`'s surface, not this one's,
 * and this check must never be the reason a broken file reads as "fine".
 */
export function undefinedRefs(source, { globals = runtimeGlobals() } = {}) {
  // Acorn parses a shebang fine on its own recognisance in recent versions, but
  // `#!` at offset 0 is not otherwise legal ECMAScript — blank it defensively, in a
  // way that cannot shift any line or column a finding is reported against.
  const code = source.startsWith('#!') ? '//' + source.slice(2) : source;

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: ECMA_VERSION, sourceType: 'module', locations: true, ranges: true });
  } catch {
    return [];
  }

  let manager;
  try {
    manager = eslintScope.analyze(ast, {
      ecmaVersion: ECMA_VERSION,
      sourceType: 'module',
      ignoreEval: true,
      optimistic: false,
    });
  } catch {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const ref of manager.globalScope.through) {
    const { name } = ref.identifier;
    if (globals.has(name)) continue;
    const loc = ref.identifier.loc.start;
    const key = `${name}:${loc.line}:${loc.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, line: loc.line, column: loc.column + 1 });
  }
  out.sort((a, b) => a.line - b.line || a.column - b.column);
  return out;
}

/**
 * Every finding across `dirs`, as `{file, name, line, column}` — `file` is
 * repo-relative, so a finding is a location you can go straight to.
 */
export function checkTree(root, { dirs = SCAN_DIRS, globals = runtimeGlobals() } = {}) {
  const findings = [];
  for (const file of scanFiles(root, dirs)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const ref of undefinedRefs(source, { globals })) {
      findings.push({ file, ...ref });
    }
  }
  return findings;
}
