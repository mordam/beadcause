/**
 * The reverse index five sessions each built by hand before writing a function that
 * might already exist: every top-level declaration in `lib/` (and `bin/`, `scripts/`),
 * exported or not, keyed by its name and the first line of its own doc comment.
 *
 * `bc-dgx7.62` found `ago(ms)` in three calls and then discovered it was not exported
 * — a fourth call it had no way to see coming. `bc-dgx7.64` grepped `^export function
 * resolveSessionDir` twice and got nothing, because the real declaration is `export
 * const resolveSessionDir = (cfg, workspace, bead = null) => ...` — an arrow assigned
 * to a `const`, the shape `^export function` structurally cannot match. Both gaps are
 * the same gap: nothing in this repo answered "is this exported" and "what is this
 * called" from the same call, because nothing parsed the declaration itself rather
 * than grepping for one written form of it.
 *
 * `lib/imports.js` already parses this tree with acorn for a related but different
 * question — where a symbol already known by name is exported from. This file asks
 * the question those five sessions actually had: given only a *description* of what
 * they wanted, what already exists, named how, and can it be imported at all. It is
 * its own parse (not a reuse of `lib/imports.js`'s `exportsOf`) because it also needs
 * every comment in the file, to answer "what does this do" without opening it.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { scanFiles, SCAN_DIRS } from './noundef.js';

export { SCAN_DIRS };

// Same version lib/noundef.js and lib/imports.js pin, for the same reason: this
// repo's own source parses fine at 2022, and a tool that disagreed with the checks it
// sits beside could silently skip a file neither of them names.
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

/** The first real line of the nearest `/** ... *&#47;` block comment sitting directly
 * before `beforePos` — nothing but whitespace between the two. A `//` line comment, or
 * a plain `/* */` block that doesn't open with the doc-comment `*`, doesn't count:
 * this repo's own convention (see lib/noundef.js, lib/imports.js) is the `/**` form. */
function docCommentBefore(source, comments, beforePos) {
  let best = null;
  for (const c of comments) {
    if (c.type !== 'Block') continue;
    if (c.end > beforePos) continue;
    if (!/^\s*$/.test(source.slice(c.end, beforePos))) continue;
    if (!best || c.end > best.end) best = c;
  }
  if (!best || !best.value.startsWith('*')) return null;
  for (const raw of best.value.split('\n')) {
    const line = raw.replace(/^[ \t]*\*[ \t]?/, '').trim();
    if (line) return line;
  }
  return null;
}

/** `(a, b = 1, { c } = {})` — the parameter list exactly as written, reconstructed
 * from source rather than re-derived from the AST shapes, so a default value or a
 * destructured pattern prints the way a reader typed it. */
function paramsOf(source, fnNode) {
  return fnNode.params.map((p) => source.slice(p.start, p.end)).join(', ');
}

function functionSignature(source, name, fnNode, { asConst = false } = {}) {
  const async = fnNode.async ? 'async ' : '';
  const star = fnNode.generator ? '*' : '';
  const params = `(${paramsOf(source, fnNode)})`;
  if (fnNode.type === 'ArrowFunctionExpression') {
    return `const ${name} = ${async}${params} =>`;
  }
  const kw = `${async}function${star}`;
  return asConst ? `const ${name} = ${kw}${params}` : `${kw} ${name}${params}`;
}

function classSignature(source, name, classNode) {
  const ext = classNode.superClass ? ` extends ${source.slice(classNode.superClass.start, classNode.superClass.end)}` : '';
  return `class ${name}${ext}`;
}

const MAX_VALUE_LEN = 60;

function valueSignature(source, kind, name, initNode) {
  if (!initNode) return `${kind} ${name}`;
  let text = source.slice(initNode.start, initNode.end);
  if (text.length > MAX_VALUE_LEN) text = `${text.slice(0, MAX_VALUE_LEN)}…`;
  return `${kind} ${name} = ${text}`;
}

function methodEntry(source, comments, file, className, classExported, methodNode) {
  const key = methodNode.key;
  const name =
    key.type === 'PrivateIdentifier' ? `#${key.name}` : key.type === 'Identifier' ? key.name : source.slice(key.start, key.end);
  const fn = methodNode.value;
  const prefixParts = [];
  if (methodNode.static) prefixParts.push('static');
  if (fn.async) prefixParts.push('async');
  if (methodNode.kind === 'get' || methodNode.kind === 'set') prefixParts.push(methodNode.kind);
  const prefix = prefixParts.length ? `${prefixParts.join(' ')} ` : '';
  const star = fn.generator ? '*' : '';
  const signature = `${prefix}${star}${name}(${paramsOf(source, fn)})`;
  return {
    file,
    line: methodNode.loc.start.line,
    exported: classExported,
    kind: 'method',
    ownerClass: className,
    name: `${className}.${name}`,
    signature,
    doc: docCommentBefore(source, comments, methodNode.start),
  };
}

/**
 * Every top-level declaration `file` makes — function, class, and `const`/`let`/`var`
 * bound to a plain identifier — plus, for each class, one entry per method on it.
 * `exported` is true for anything reached through an `export` (named or default);
 * everything else is `private`, in the sense this whole tool exists to name: declared
 * here, but nothing outside this file can import it.
 *
 * Destructuring declarators (`const { a, b } = ...`) and default exports of an
 * already-declared identifier (`export default someName`) are skipped — neither
 * names a fresh declaration at this position, which is what this index is over.
 */
export function moduleSurface(root, file) {
  const abs = path.join(root, file);
  const source = fs.readFileSync(abs, 'utf8');
  const parsed = parseWithComments(source);
  if (!parsed) return [];
  const { ast, comments } = parsed;
  const out = [];

  for (const stmt of ast.body) {
    let exported = false;
    let decl = stmt;
    let outerStart = stmt.start;
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      exported = true;
      decl = stmt.declaration;
      outerStart = stmt.start;
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      exported = true;
      decl = stmt.declaration;
      outerStart = stmt.start;
    }
    if (!decl) continue;

    const doc = docCommentBefore(source, comments, outerStart);
    const line = outerStart === stmt.start ? stmt.loc.start.line : decl.loc.start.line;

    if (decl.type === 'FunctionDeclaration' && decl.id) {
      out.push({
        file,
        line,
        exported,
        kind: 'function',
        name: decl.id.name,
        signature: functionSignature(source, decl.id.name, decl),
        doc,
      });
    } else if (decl.type === 'ClassDeclaration' && decl.id) {
      out.push({
        file,
        line,
        exported,
        kind: 'class',
        name: decl.id.name,
        signature: classSignature(source, decl.id.name, decl),
        doc,
      });
      for (const member of decl.body.body) {
        if (member.type !== 'MethodDefinition') continue;
        out.push(methodEntry(source, comments, file, decl.id.name, exported, member));
      }
    } else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue;
        const name = d.id.name;
        const declLine = d.loc.start.line;
        const declDoc = docCommentBefore(source, comments, outerStart) ?? doc;
        if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) {
          out.push({
            file,
            line: declLine,
            exported,
            kind: 'const',
            name,
            signature: functionSignature(source, name, d.init, { asConst: true }),
            doc: declDoc,
          });
        } else if (d.init && d.init.type === 'ClassExpression') {
          const inner = classSignature(source, d.init.id ? d.init.id.name : '', d.init).replace(/^class\s*/, '').trim();
          out.push({
            file,
            line: declLine,
            exported,
            kind: 'const',
            name,
            signature: `const ${name} = class${inner ? ` ${inner}` : ''}`,
            doc: declDoc,
          });
        } else {
          out.push({
            file,
            line: declLine,
            exported,
            kind: decl.kind,
            name,
            signature: valueSignature(source, decl.kind, name, d.init),
            doc: declDoc,
          });
        }
      }
    }
  }
  return out;
}

/** `moduleSurface` over every file under `dirs` (repo-relative, sorted — same order
 * `scanFiles` gives every other check in this family). */
export function allEntries(root, { dirs = SCAN_DIRS } = {}) {
  const out = [];
  for (const file of scanFiles(root, dirs)) {
    out.push(...moduleSurface(root, file));
  }
  return out;
}

// Splits `resolveSessionDir` into `resolve Session Dir` and `STALE_LOCK_MS` into
// `STALE LOCK MS` before lowercasing — so a query word matches the pieces of a camelCase
// or SCREAMING_CASE name the way a reader would say them, not only the literal string.
function wordsIn(name) {
  return name
    .replace(/^#/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}

function haystack(entry) {
  return `${wordsIn(entry.name)} ${entry.doc || ''}`.toLowerCase();
}

/** How many of `queryWords` appear, as a substring, anywhere in `entry`'s name or the
 * first line of its doc comment — not a requirement that every word match, since the
 * doc comment for `ago(ms)` ("How long ago, in the words a refusal can use.") never
 * says "time" even though that is exactly what a caller would search for. */
export function scoreEntry(entry, queryWords) {
  const hay = haystack(entry);
  let score = 0;
  for (const w of queryWords) {
    if (w && hay.includes(w.toLowerCase())) score += 1;
  }
  return score;
}

/**
 * Every declaration under `dirs` that matches at least one of `queryWords`, best match
 * first (most words matched, then file, then line — stable regardless of scan order).
 * `onlyPrivate` narrows to declarations nothing outside their own file can import —
 * the other half of "does lib/ already have this", once the answer is yes.
 */
export function search(root, queryWords, { dirs = SCAN_DIRS, onlyPrivate = false } = {}) {
  let entries = allEntries(root, { dirs });
  if (onlyPrivate) entries = entries.filter((e) => !e.exported);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryWords) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line)
    .map((s) => s.entry);
}
