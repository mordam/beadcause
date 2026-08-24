/**
 * The four questions a session asks by hand before touching an import block —
 * "where is this exported from, is it already imported, would it collide, would it
 * cycle" — and the fifth for the other direction, "what dies if these leave".
 *
 * bc-ka5y.30 is the session audit: four beads (bc-ka5y.15.8, bc-ka5y.15.7, bc-xl7n.93,
 * bc-36xx.18) each answered the same questions with four to six greps, in a different
 * order, with different false positives — `heldBy` matching the substring `held` twelve
 * times over, two unrelated `SEVERITIES` exports read as a possible collision until
 * both were opened by hand. `lib/noundef.js` already parses every file in `lib/`, `bin/`
 * and `scripts/` with acorn and hands the AST to `eslint-scope` for exactly this reason
 * — a name is a binding, not a string — and this reuses its `scanFiles`/`SCAN_DIRS`
 * rather than walking the tree a second way.
 *
 * Two directions:
 *
 *   exportsOf / findExporters / alreadyImported / localCollision / insertionLine /
 *   cycleIfImported     — "before adding an import": where a symbol is really exported
 *                          from, whether it is already imported, what it would collide
 *                          with, and whether adding it would close a cycle.
 *
 *   deadOnRemoval        — the other half: given symbols already declared in a file,
 *                          what other top-level bindings in that same file (an import,
 *                          a local `const`/`function`/`class`) were used only by the
 *                          symbols being removed, and which other files in the tree
 *                          still reference the removed names at all.
 *
 * Both directions answer by identifier, via real scope resolution — `eslint-scope`
 * reports a *reference*, with a location, never a text match — which is what makes the
 * `heldBy`-inside-`held` false positive structurally impossible here rather than merely
 * avoided by a tighter regex.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';
import { scanFiles, SCAN_DIRS } from './noundef.js';

export { SCAN_DIRS };

/** `SCAN_DIRS` plus `test` — used only by `deadOnRemoval`'s cross-file check, because
 * that is exactly where bc-xl7n.93's twelve false positives were sitting. `findExporters`
 * deliberately does not use this: the bead asks for "every other module in lib/, bin/
 * and scripts/", and a test file exporting a same-named helper is not the collision this
 * tool exists to name. */
export const REFERENCE_SCAN_DIRS = [...SCAN_DIRS, 'test'];

// Same version lib/noundef.js pins, for the same reason: everything this repo's source
// actually uses parses fine at 2022, and a tool that parsed at a different version than
// the check it borrows from could disagree with it on a file neither of them names.
const ECMA_VERSION = 2022;

function stripShebang(source) {
  return source.startsWith('#!') ? '//' + source.slice(2) : source;
}

/** Parse `source` as this repo's own dialect (ESM, 2022). `null` on a syntax error —
 * a broken file is `node --check`'s surface, not this one's, same rule as noundef.js. */
export function parseModule(source) {
  try {
    return acorn.parse(stripShebang(source), {
      ecmaVersion: ECMA_VERSION,
      sourceType: 'module',
      locations: true,
      ranges: true,
    });
  } catch {
    return null;
  }
}

function analyzeScope(ast) {
  try {
    return eslintScope.analyze(ast, {
      ecmaVersion: ECMA_VERSION,
      sourceType: 'module',
      ignoreEval: true,
      optimistic: false,
    });
  } catch {
    return null;
  }
}

/** Every name a `VariableDeclaration`/`FunctionDeclaration`/`ClassDeclaration` binds,
 * destructuring included — the same shapes lib/noundef.js's scope walk already has to
 * resolve, named here because `export`'s own declaration form wraps one of these. */
function declaredNames(decl) {
  const names = [];
  if (!decl) return names;
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) collectPatternNames(d.id, names);
  } else if (decl.id) {
    names.push(decl.id.name);
  }
  return names;
}

function collectPatternNames(pattern, out) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) {
      if (p.type === 'RestElement') collectPatternNames(p.argument, out);
      else collectPatternNames(p.value, out);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) collectPatternNames(el, out);
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, out);
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, out);
  }
}

/**
 * Every export `source` makes, as `{name, kind, from, line}`:
 *   'named'              — `export const/function/class X`, or `export { X }`
 *   'default'            — `export default ...`; `name` is the identifier when there
 *                           is one (`export default function foo(){}`), else `'default'`
 *   'reexport-named'     — `export { X } from './other.js'`
 *   'reexport-namespace' — `export * as NS from './other.js'`
 *   'reexport-all'       — `export * from './other.js'` (`name` is `'*'` — a wildcard
 *                           re-export cannot name what it carries without also parsing
 *                           `from`, which callers do themselves when they need to)
 */
export function exportsOf(source) {
  const ast = parseModule(source);
  if (!ast) return [];
  const out = [];
  for (const node of ast.body) {
    const line = node.loc.start.line;
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        for (const name of declaredNames(node.declaration)) out.push({ name, kind: 'named', from: null, line });
      }
      for (const spec of node.specifiers) {
        const from = node.source ? node.source.value : null;
        out.push({
          name: spec.exported.name ?? spec.exported.value,
          kind: from ? 'reexport-named' : 'named',
          from,
          local: spec.local.name,
          line,
        });
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      const name = (decl && decl.id && decl.id.name) || (decl && decl.type === 'Identifier' ? decl.name : null);
      out.push({ name: name ?? 'default', kind: 'default', from: null, line });
    } else if (node.type === 'ExportAllDeclaration') {
      const from = node.source.value;
      if (node.exported) out.push({ name: node.exported.name, kind: 'reexport-namespace', from, line });
      else out.push({ name: '*', kind: 'reexport-all', from, line });
    }
  }
  return out;
}

/** Every top-level `import` in `source`, as `{source, specifiers, line, endLine}` —
 * `specifiers`: `[{imported, local, kind}]`, `kind` one of `'named' | 'default' |
 * 'namespace'`, `imported` is `'default'`/`'*'` for those two. */
export function importsOf(source) {
  const ast = parseModule(source);
  if (!ast) return [];
  const out = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const specifiers = node.specifiers.map((spec) => {
      if (spec.type === 'ImportDefaultSpecifier') return { imported: 'default', local: spec.local.name, kind: 'default' };
      if (spec.type === 'ImportNamespaceSpecifier') return { imported: '*', local: spec.local.name, kind: 'namespace' };
      return { imported: spec.imported.name ?? spec.imported.value, local: spec.local.name, kind: 'named' };
    });
    out.push({ source: node.source.value, specifiers, line: node.loc.start.line, endLine: node.loc.end.line });
  }
  return out;
}

/**
 * The 1-based line a new `import` statement would be appended at: one past the last
 * existing import, or line 1 if `source` imports nothing. This repo's own import blocks
 * are not alphabetised or grouped by topic — `lib/advocate.js` adds each one at the end,
 * in the order it arrived — so "where would this go" is answered the way this tree
 * actually answers it, not by a sort this file would be the first to invent.
 */
export function insertionLine(source) {
  const imports = importsOf(source);
  return imports.length ? imports[imports.length - 1].endLine + 1 : 1;
}

/** Whether `symbolName` is already imported into `source` — `null` if not, else
 * `{source, line, local, kind}` for the import statement that carries it. */
export function alreadyImported(source, symbolName) {
  for (const imp of importsOf(source)) {
    for (const spec of imp.specifiers) {
      if (spec.local === symbolName || spec.imported === symbolName) {
        return { source: imp.source, line: imp.line, local: spec.local, kind: spec.kind };
      }
    }
  }
  return null;
}

/**
 * An existing top-level `const`/`function`/`class` named `symbolName` already declared
 * in `source` — not an import (see `alreadyImported` for that; whether an existing
 * import is the *right* one, i.e. from the same module a new import would come from,
 * is a question only the caller can answer, since this function is not told what that
 * module is). `null` if there is no such local declaration.
 */
export function localCollision(source, symbolName) {
  const ast = parseModule(source);
  if (!ast) return null;
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') continue;
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!decl) continue;
    if (!['VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration'].includes(decl.type)) continue;
    if (declaredNames(decl).includes(symbolName)) {
      const kind = decl.type === 'VariableDeclaration' ? 'local' : decl.type === 'FunctionDeclaration' ? 'function' : 'class';
      return { kind, line: node.loc.start.line };
    }
  }
  return null;
}

/** Every file under `dirs` that exports `symbolName`, as `{file, kind, from, line}` —
 * `file` repo-relative. A name exported from more than one place is returned as more
 * than one row, never narrowed to a first match; naming the collision is the point. */
export function findExporters(root, symbolName, { dirs = SCAN_DIRS } = {}) {
  const out = [];
  for (const file of scanFiles(root, dirs)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const exp of exportsOf(source)) {
      if (exp.name === symbolName) out.push({ file, kind: exp.kind, from: exp.from, line: exp.line });
    }
  }
  return out;
}

/** Resolve a relative import specifier written inside `fromFile` to a repo-relative
 * path — `null` for a bare/package specifier (not part of this tree) or one that
 * resolves to nothing on disk. Exported so a caller holding a raw specifier (from
 * `alreadyImported`, say) can answer "is that the same module a fresh import would
 * name" without resolving it a second, possibly different, way. */
export function resolveImport(root, fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  let resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
  if (fs.existsSync(path.join(root, resolved)) && fs.statSync(path.join(root, resolved)).isFile()) return resolved;
  if (!/\.[mc]?js$/.test(resolved)) {
    const withExt = `${resolved}.js`;
    if (fs.existsSync(path.join(root, withExt))) return withExt;
  }
  return null;
}

/**
 * Whether importing `fromModule` into `targetFile` would close an import cycle — i.e.
 * whether `fromModule` already (transitively, following only relative imports that
 * resolve inside `dirs`) imports `targetFile`, including `fromModule === targetFile`
 * itself. Returns the chain as repo-relative paths, `targetFile` first and last, or
 * `null` when there is none.
 */
export function cycleIfImported(root, targetFile, fromModule, { dirs = SCAN_DIRS } = {}) {
  const visited = new Set();
  const stack = [[fromModule]];
  while (stack.length) {
    const chain = stack.pop();
    const current = chain[chain.length - 1];
    if (current === targetFile) return [targetFile, ...chain];
    if (visited.has(current)) continue;
    visited.add(current);
    let source;
    try {
      source = fs.readFileSync(path.join(root, current), 'utf8');
    } catch {
      continue;
    }
    for (const imp of importsOf(source)) {
      const resolved = resolveImport(root, current, imp.source);
      if (resolved && !visited.has(resolved)) stack.push([...chain, resolved]);
    }
  }
  return null;
}

/** Every `Identifier`/`PrivateIdentifier` name that appears anywhere in `ast` — a plain
 * structural walk, not scope-aware. Used only to ask "does this other file mention this
 * name at all", where a real identifier node is already a stronger answer than any
 * substring grep: `obj.heldBy` and `held` are different `Identifier` nodes, full stop,
 * which is the exact case that cost bc-xl7n.93 twelve false positives by hand. */
function collectIdentifierNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) collectIdentifierNames(el, out);
    return;
  }
  if (typeof node.type === 'string' && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) {
    out.add(node.name);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const val = node[key];
    if (val && typeof val === 'object') collectIdentifierNames(val, out);
  }
}

/**
 * The other half of the question: given `symbols` already declared at the top level of
 * `file`, what becomes dead if they leave, and who else in the tree still says their
 * name.
 *
 * `deadImports`/`deadLocals` — an import or a local `const`/`function`/`class` in
 * `file`, not itself among `symbols`, every one of whose real references (by identifier,
 * via `eslint-scope` — never counting the reference a declaration makes to its own name)
 * sits inside one of the declarations named in `symbols`. A binding with zero references
 * even before the removal is not reported — that is a pre-existing dead end, not one
 * this removal causes, and not this tool's question.
 *
 * `stillReferencedFrom` — every *other* file under `dirs` whose AST contains an
 * `Identifier` named after one of `symbols` — the cross-file check bc-xl7n.93 did with
 * `grep -rln` and had to disprove twelve false hits from by hand.
 *
 * `missing` — any name in `symbols` that is not actually declared at `file`'s top level,
 * so a typo is reported rather than silently answered as "nothing depends on it".
 */
export function deadOnRemoval(root, file, symbols, { dirs = REFERENCE_SCAN_DIRS } = {}) {
  const abs = path.join(root, file);
  const source = fs.readFileSync(abs, 'utf8');
  const ast = parseModule(source);
  if (!ast) return { removed: [], missing: [...symbols], deadImports: [], deadLocals: [], stillReferencedFrom: [] };

  const removedRanges = [];
  const removedFound = new Set();
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!decl || !['VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration'].includes(decl.type)) continue;
    const hit = declaredNames(decl).filter((n) => symbols.includes(n));
    if (hit.length) {
      removedRanges.push(node.range);
      for (const n of hit) removedFound.add(n);
    }
  }
  const missing = symbols.filter((s) => !removedFound.has(s));
  const insideRemoved = (pos) => removedRanges.some(([s, e]) => pos >= s && pos < e);

  const deadImports = [];
  const deadLocals = [];
  const manager = analyzeScope(ast);
  const moduleScope = manager ? manager.scopes.find((s) => s.type === 'module') || manager.globalScope : null;
  if (moduleScope) {
    for (const variable of moduleScope.variables) {
      if (removedFound.has(variable.name)) continue;
      const def = variable.defs[0];
      if (!def) continue;
      const isImport = def.type === 'ImportBinding';
      const isLocal = def.type === 'FunctionName' || def.type === 'ClassName' || def.type === 'Variable';
      if (!isImport && !isLocal) continue;
      // Exclude the reference a declaration makes to its own name (eslint-scope
      // reports `const x = ...` as a write reference at x's own binding site) — without
      // this, every binding looks "used" by itself and nothing this removal orphans is
      // ever caught.
      const usageRefs = variable.references.filter((r) => r.identifier !== def.name);
      if (!usageRefs.length) continue; // dead before this removal too — not this tool's question
      const liveRefs = usageRefs.filter((r) => !insideRemoved(r.identifier.range[0]));
      if (liveRefs.length) continue;
      const line = def.name.loc.start.line;
      if (isImport) deadImports.push({ name: variable.name, line, from: def.parent.source.value });
      else deadLocals.push({ name: variable.name, line, kind: def.type === 'FunctionName' ? 'function' : def.type === 'ClassName' ? 'class' : 'const' });
    }
  }

  const stillReferencedFrom = [];
  for (const other of scanFiles(root, dirs)) {
    if (other === file) continue;
    let osrc;
    try {
      osrc = fs.readFileSync(path.join(root, other), 'utf8');
    } catch {
      continue;
    }
    const oast = parseModule(osrc);
    if (!oast) continue;
    const names = new Set();
    collectIdentifierNames(oast, names);
    for (const name of removedFound) {
      if (names.has(name)) stillReferencedFrom.push({ file: other, name });
    }
  }

  return { removed: [...removedFound], missing, deadImports, deadLocals, stillReferencedFrom };
}
