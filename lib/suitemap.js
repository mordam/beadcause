/**
 * The inside of an existing suite — its fixtures, what it imports from the file under
 * test, and where a new check goes. `bin/b7e-suitemap` is the argv shell; this is the
 * parse.
 *
 * bc-dgx7.85 is the session audit: five sessions (bc-4jkjv, bc-3wf1r, bc-jjdar.2,
 * bc-mwhkg.2, bc-jjdar.1) each added a check to a suite that already existed, and each
 * began by reading several hundred lines of it to learn the same three things — what the
 * fixture/loader helper is called, what the suite imports from the module under test, and
 * which named check to anchor the new one after. Five sessions, five reading strategies —
 * `sed` slices, greps for anchor strings, four separate `Read`s at guessed line numbers —
 * none of them cheap, and none of them reusable by the next one.
 *
 * This parses one suite with acorn, the way `lib/already.js` and `lib/imports.js` already
 * do for the same reason they do it: a name is a binding and a call is a call, not a
 * string a regex might also find inside a comment or a `console.log`. Three things come
 * back:
 *
 * **Imports** — every `import … from './x.js'` and every `await import(LIB('x.js'))` /
 * `require(PUBLIC('x.js'))`, resolved to a repo-relative path the same way
 * `lib/affected.js`'s `parseImports` resolves the helper-call convention, plus the one
 * shape neither of those covers: a suite that loads the module under test as *text* and
 * runs it in a `vm` (`test/reporter.mjs`, `test/dictate.mjs`) rather than importing it —
 * `fs.readFileSync(PUBLIC('report.js'), 'utf8')` is reported as a `vm-source` import of
 * `public/report.js`, because that is exactly as load-bearing as an `import` for someone
 * about to change what that file exports.
 *
 * **Helpers** — every other top-level declaration: the loader, the fixture builder, the
 * reset, with its signature and line. A loader that builds a `vm` context and returns an
 * object (`test/reporter.mjs`'s `load`) is expanded one level — the keys of its `return`
 * — because the thing a caller actually needs (`fire`, in that suite) is a property of
 * what the loader hands back, not a sibling declaration next to it.
 *
 * **Checks** — every call to this suite's own `check`/`ok`/`bad`/`fail`/`pass` binding
 * (whichever of those five it declares — `HARNESS_MEMBER` in `lib/harness.js` names the
 * same five) with a literal string title, in source order, grouped under the nearest
 * `/* --- section --- *\/`-style divider above it — the convention `test/homing.mjs` and
 * three hundred other suites already write in, just never printed back.
 *
 * What this deliberately does not do: follow a per-file convenience wrapper (a suite's
 * own `is(name, got, want)` that calls `ok`/`bad` internally) back to the titles it
 * passes through. Those are real checks and this will not list them — the alternative is
 * chasing an unbounded per-file naming scheme, and the five sessions this replaces all
 * hit suites using the five-name convention, not a home-grown one.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { REPO_ROOT, SOURCE_DIRS, findAffected, toRepoRel } from './affected.js';

export { REPO_ROOT };

// Same version lib/noundef.js, lib/imports.js and lib/already.js pin, for the same
// reason: this repo's own source parses fine at 2022, and a tool that disagreed with
// the checks it sits beside could silently skip a file none of them names.
const ECMA_VERSION = 2022;

function stripShebang(source) {
  return source.startsWith('#!') ? '//' + source.slice(2) : source;
}

/** Parse `source`, collecting every comment alongside the AST. `null` on a syntax
 * error — a broken file is `node --check`'s surface, not this one's. */
function parseWithComments(source) {
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(stripShebang(source), {
      ecmaVersion: ECMA_VERSION,
      sourceType: 'module',
      locations: true,
      ranges: true,
      onComment: comments,
    });
  } catch {
    return null;
  }
  return { ast, comments };
}

const HARNESS_LEAF_NAMES = ['check', 'ok', 'bad', 'fail', 'pass'];

const isFunctionValued = (node) =>
  node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration');

/** The single name a top-level statement declares, if it declares exactly one — a
 * `function foo(...)` or a `const foo = ...` (destructuring excluded; nothing here
 * needs it and a `{ a, b } = ...` is never a fixture builder by itself). */
function topLevelBinding(stmt) {
  if (stmt.type === 'FunctionDeclaration' && stmt.id) return { name: stmt.id.name, node: stmt };
  if (stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) {
    const d = stmt.declarations[0];
    if (d.id.type === 'Identifier') return { name: d.id.name, node: d.init, declLine: d.loc.start.line };
  }
  return null;
}

/**
 * `const LIB = (f) => path.join(HERE, '..', 'lib', f)` and its `PUBLIC` sibling — the
 * same convention `lib/affected.js`'s `localHelperDirs` reads, duplicated here rather
 * than imported because that one is not exported and the whole of it is one regex over
 * one call shape.
 */
function localHelperDirs(source) {
  const dirs = {};
  const re = /\bconst\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\(\s*[\w]+\s*\)\s*=>\s*path\.join\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(source))) {
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

/** `{ a, b: renamed, c = 1 }` or a bare `mod` — every name a destructure (or a plain
 * identifier) binds, in written order. */
function namesOf(idNode) {
  if (idNode.type === 'Identifier') return [idNode.name];
  if (idNode.type !== 'ObjectPattern') return [];
  const out = [];
  for (const prop of idNode.properties) {
    if (prop.type === 'RestElement') {
      if (prop.argument.type === 'Identifier') out.push(`...${prop.argument.name}`);
      continue;
    }
    let value = prop.value;
    if (value.type === 'AssignmentPattern') value = value.left;
    if (value.type === 'Identifier') out.push(value.name);
  }
  return out;
}

/** The repo-relative file a relative specifier resolves to, or `null` if it does not
 * resolve to a real file (a bare package specifier, a `node:` builtin). */
function resolveRelative(root, fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.join(path.dirname(path.join(root, fromFile)), spec);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return path.relative(root, abs).split(path.sep).join('/');
}

/** The repo-relative file a helper call (`LIB('x.js')`) resolves to, or `null`. */
function resolveHelperCall(root, helperDirs, name, arg) {
  const dir = helperDirs[name];
  if (!dir) return null;
  const abs = path.join(root, dir, arg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Unwrap `await x` down to `x`. */
const unawait = (node) => (node && node.type === 'AwaitExpression' ? node.argument : node);

/** The `{ helperName, arg }` a `LIB('x.js')`-shaped call expresses, or `null`. */
function helperCallArg(node) {
  if (!node || node.type !== 'CallExpression') return null;
  if (node.callee.type !== 'Identifier') return null;
  if (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal') return null;
  return { helperName: node.callee.name, arg: node.arguments[0].value };
}

/**
 * Every import this suite makes of a file in this repo — static `import`, the
 * `await import(LIB('x.js'))` convention, and a suite that loads the module under test
 * as text and runs it in a `vm` rather than importing it at all.
 */
function importsFrom(root, relFile, ast, source, helperDirs) {
  const out = [];
  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') {
      const names = [];
      for (const spec of stmt.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') names.push(spec.local.name);
        else if (spec.type === 'ImportNamespaceSpecifier') names.push(`* as ${spec.local.name}`);
        else names.push(spec.imported.name === spec.local.name ? spec.local.name : `${spec.imported.name} as ${spec.local.name}`);
      }
      const resolved = resolveRelative(root, relFile, stmt.source.value);
      out.push({ kind: 'static', names, spec: stmt.source.value, resolved, line: stmt.loc.start.line });
      continue;
    }
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      const init = unawait(d.init);
      if (!init) continue;
      const line = d.loc.start.line;
      if (init.type === 'ImportExpression') {
        const names = namesOf(d.id);
        const call = helperCallArg(init.source);
        if (call) {
          out.push({
            kind: 'dynamic',
            names,
            spec: `${call.helperName}('${call.arg}')`,
            resolved: resolveHelperCall(root, helperDirs, call.helperName, call.arg),
            line,
          });
        } else if (init.source.type === 'Literal') {
          out.push({ kind: 'dynamic', names, spec: init.source.value, resolved: resolveRelative(root, relFile, init.source.value), line });
        }
        continue;
      }
      // `const SOURCE = fs.readFileSync(PUBLIC('report.js'), 'utf8')` — the module under
      // test loaded as text for a `vm`, not imported. Only `d.id` an `Identifier`: this
      // is naming one constant, never a destructure.
      if (
        init.type === 'CallExpression' &&
        init.callee.type === 'MemberExpression' &&
        init.callee.object.type === 'Identifier' &&
        init.callee.object.name === 'fs' &&
        init.callee.property.type === 'Identifier' &&
        /^readFileSync$/.test(init.callee.property.name) &&
        d.id.type === 'Identifier'
      ) {
        const call = helperCallArg(init.arguments[0]);
        if (call) {
          const resolved = resolveHelperCall(root, helperDirs, call.helperName, call.arg);
          if (resolved) out.push({ kind: 'vm-source', names: [d.id.name], spec: `${call.helperName}('${call.arg}')`, resolved, line });
        } else if (init.arguments[0] && init.arguments[0].type === 'Literal') {
          const resolved = resolveRelative(root, relFile, init.arguments[0].value);
          if (resolved) out.push({ kind: 'vm-source', names: [d.id.name], spec: init.arguments[0].value, resolved, line });
        }
      }
    }
  }
  return out;
}

/** `(a, b = 1, { c } = {})`, read straight off the source rather than re-derived from
 * the AST shapes, so a default value or a destructured pattern prints the way it was
 * written. */
const paramsOf = (source, fnNode) => fnNode.params.map((p) => source.slice(p.start, p.end)).join(', ');

function signatureOf(source, name, node) {
  const async = node.async ? 'async ' : '';
  const params = `(${paramsOf(source, node)})`;
  if (node.type === 'ArrowFunctionExpression') return `${name} = ${async}${params} =>`;
  const star = node.generator ? '*' : '';
  if (node.type === 'FunctionDeclaration') return `${async}function${star} ${name}${params}`;
  return `${name} = ${async}function${star}${params}`;
}

/**
 * The object keys a function-valued helper hands back, one level deep — `return {
 * window, ctx, fire, ... }` at the top of the function's own body, not inside a nested
 * closure. This is how `fire` shows up under `load` in `test/reporter.mjs`: it is not a
 * sibling declaration, it is a property of what the loader returns, and that is what a
 * caller reading this suite actually needs to know exists.
 */
function returnedKeys(node) {
  const body = node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement' ? null : node.body;
  if (!body || body.type !== 'BlockStatement') return null;
  for (const stmt of body.body) {
    if (stmt.type !== 'ReturnStatement' || !stmt.argument || stmt.argument.type !== 'ObjectExpression') continue;
    const keys = [];
    for (const prop of stmt.argument.properties) {
      if (prop.type === 'SpreadElement') {
        keys.push('...');
        continue;
      }
      if (prop.key.type === 'Identifier') keys.push(prop.key.name);
      else if (prop.key.type === 'Literal') keys.push(String(prop.key.value));
    }
    return keys;
  }
  return null;
}

/** Every top-level declaration that is not one of this suite's own harness leaves, or
 * a `LIB`/`PUBLIC`-shaped path helper — the fixture builders, loaders and resets a new
 * check would call. */
function helpersOf(source, ast, harnessLeaves, helperDirs) {
  const out = [];
  for (const stmt of ast.body) {
    const top = topLevelBinding(stmt);
    if (!top || harnessLeaves.has(top.name) || helperDirs[top.name]) continue;
    if (!isFunctionValued(top.node)) continue;
    out.push({
      name: top.name,
      line: (top.declLine ?? stmt.loc.start.line),
      signature: signatureOf(source, top.name, top.node),
      returns: returnedKeys(top.node),
    });
  }
  return out;
}

/** Which of `check`/`ok`/`bad`/`fail`/`pass` this suite actually declares as a
 * function — the same five `HARNESS_MEMBER` in `lib/harness.js` names, found the same
 * way: a top-level binding with that exact name, valued as a function. */
function harnessLeavesOf(ast) {
  const leaves = new Set();
  for (const stmt of ast.body) {
    const top = topLevelBinding(stmt);
    if (top && HARNESS_LEAF_NAMES.includes(top.name) && isFunctionValued(top.node)) leaves.add(top.name);
  }
  return leaves;
}

/** A literal string, or a template literal with nothing to interpolate — the only two
 * shapes a check title is ever written in across this repo's `test/`. */
function literalTitle(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** A call to one of this suite's harness leaves, with a literal title — `check('...',
 * ...)` unwrapped from an optional `await`, or one branch of a top-level `cond ? ok('x')
 * : bad('x', why)` ternary (the `is(name, got, want)` idiom some suites use in place of
 * a wrapping `check`). */
function harnessCallsIn(expr, leaves) {
  const node = unawait(expr);
  if (!node) return [];
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && leaves.has(node.callee.name) && node.arguments[0]) {
    const title = literalTitle(node.arguments[0]);
    return title === null ? [] : [{ title, line: node.loc.start.line }];
  }
  if (node.type === 'ConditionalExpression') {
    return [...harnessCallsIn(node.consequent, leaves), ...harnessCallsIn(node.alternate, leaves)];
  }
  return [];
}

/** `/* --------- title --------- *\/`-shaped block comments, the divider convention
 * `test/homing.mjs` and hundreds of other suites use to mark a run of checks. */
function sectionsFrom(comments) {
  const out = [];
  const re = /^\s*-{4,}\s*(.+?)\s*-*\s*$/;
  for (const c of comments) {
    if (c.type !== 'Block') continue;
    const m = re.exec(c.value);
    if (m) out.push({ title: m[1], line: c.loc.start.line });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Every check title in source order, each tagged with the nearest section divider at
 * or above its own line — `null` for a check that comes before the first one. */
function checksOf(ast, leaves, sections) {
  const calls = [];
  for (const stmt of ast.body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    calls.push(...harnessCallsIn(stmt.expression, leaves));
  }
  calls.sort((a, b) => a.line - b.line);
  return calls.map((c) => {
    let section = null;
    for (const s of sections) {
      if (s.line <= c.line) section = s.title;
      else break;
    }
    return { ...c, section };
  });
}

/**
 * The full map of one suite: its imports of files in this repo, its file-local
 * helpers, and its named checks in order. `null` if the file does not exist or does
 * not parse.
 */
export function mapSuite(root, relFile) {
  const abs = path.join(root, relFile);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseWithComments(source);
  if (!parsed) return null;
  const { ast, comments } = parsed;

  const helperDirs = localHelperDirs(source);
  const harnessLeaves = harnessLeavesOf(ast);
  const sections = sectionsFrom(comments);

  return {
    suite: relFile,
    lines: source.split('\n').length,
    harness: [...harnessLeaves].sort(),
    imports: importsFrom(root, relFile, ast, source, helperDirs),
    helpers: helpersOf(source, ast, harnessLeaves, helperDirs),
    checks: checksOf(ast, harnessLeaves, sections),
  };
}

// Weakest to strongest is the order `lib/affected.js`'s own docblock gives the five —
// reversed here because a lower number wins the sort.
const REASON_RANK = {
  'imports it': 0,
  'serves this page': 1,
  'reads its source text': 2,
  'shares its name': 3,
  'names it in a string': 4,
  'walks the tree': 5,
};

/**
 * Resolve `--for <file>` to the suite that covers it, through `lib/affected.js` — the
 * same matching `b7e-affected` prints, narrowed to the one file given and the one
 * result taken. `null` if nothing covers it.
 *
 * More than one suite matching is the ordinary case, not an edge one: a dozen suites
 * that walk every `public/*.js` file for an unrelated convention check all "read its
 * source text" just as much as the one suite actually written for it — and
 * `lib/affected.js`'s own text scan cannot see the `PUBLIC('report.js')` helper-call
 * convention at all (the literal it is looking for is split across two calls), so
 * `test/reporter.mjs` reaches it only as a directory-walker, its weakest reason. This
 * parses every candidate with `mapSuite` and lets an actual `vm-source`/`dynamic`/
 * `static` import of the target — found the same precise way `mapSuite` finds one for
 * display — override `lib/affected.js`'s own text-based ranking outright. Only when no
 * candidate imports it directly does reason strength decide, and what is left after
 * that is broken by whether the suite's own name is built from the target's —
 * `report.js` vs. `reporter.mjs` — before falling back to alphabetical so the answer
 * never depends on iteration order.
 */
export function suiteFor(root, targetRel) {
  const { results } = findAffected(root, [targetRel]);
  const found = results.find((r) => r.file === targetRel);
  if (!found || !found.matches.length) return null;

  const direct = found.matches.filter((m) => {
    const mapped = mapSuite(root, m.suite);
    return mapped && mapped.imports.some((i) => i.resolved === targetRel);
  });
  const pool = direct.length ? direct : found.matches;

  const targetStem = path.parse(targetRel).name.toLowerCase();
  const ranked = [...pool].sort((a, b) => {
    const ar = Math.min(...a.reasons.map((r) => REASON_RANK[r] ?? 9));
    const br = Math.min(...b.reasons.map((r) => REASON_RANK[r] ?? 9));
    if (ar !== br) return ar - br;
    const aStem = path.parse(a.suite).name.toLowerCase();
    const bStem = path.parse(b.suite).name.toLowerCase();
    const aHit = aStem.includes(targetStem) || targetStem.includes(aStem) ? 0 : 1;
    const bHit = bStem.includes(targetStem) || targetStem.includes(bStem) ? 0 : 1;
    if (aHit !== bHit) return aHit - bHit;
    return a.suite < b.suite ? -1 : a.suite > b.suite ? 1 : 0;
  });
  const rest = found.matches.filter((m) => m.suite !== ranked[0].suite).map((m) => m.suite);
  const reasons = direct.length ? ['imports it directly'] : ranked[0].reasons;
  return { suite: ranked[0].suite, reasons, others: rest };
}

export { toRepoRel };
