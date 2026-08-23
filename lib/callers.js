/**
 * Who calls this, who imports it, and is anything wired to it at all — `bin/b7e-callers`
 * is the argv shell; this is the matching.
 *
 * `bc-36xx.24` names seven sessions (`bc-36xx.5`, `bc-36xx.4`, `bc-zjab.2`, `bc-khoe.30.3`,
 * `bc-5e85`, `bc-zjab`, `bc-zjab.1`) that each asked "who calls this" by hand, differently,
 * and got it wrong at least twice: a zsh glob (`--include=*.js`) silently expanded before
 * `grep` ever saw it, a doc-comment sentence naming a function read back as a real call
 * site, and a real call site written as `beadcause?.views?.mark?.(...)` — optional
 * chaining — matched nothing against a literal `views.mark` search. This file is the one
 * answer: a definition site, every call site classified (call / bare reference / comment
 * mention / import), and a one-line verdict, because "grep returns nothing" and "this is
 * genuinely dead" read identically in a terminal and only one of them is true.
 *
 * ## Reused rather than rebuilt
 *
 * `lib/affected.js` already owns the import graph this needs for `--imports`
 * (`buildGraph`, `closureOf`) and the source-dir inventory (`SOURCE_DIRS`, `REPO_ROOT`).
 * Nothing here re-derives either. What is new is the other half: given a *symbol* rather
 * than a *file*, where it is bound and where it is actually invoked — `bin/b7e-def`
 * already answers "where is this defined, and what lines mention it" with the same
 * line-oriented, comment/string-aware scanner this borrows the shape of
 * (`skipString`/`findBody`/`matchBrace`/`definitionsFor`/`importsFor`), but its own
 * `--callers` is a bare `name(` regex with no comment-stripping and no verdict — the gap
 * `bc-36xx.5`'s own history proves costly (`grep -rn "approvedReview\|approvalComment"`
 * came back empty because the search was scoped wrong, not because nothing existed).
 *
 * ## A comment-aware blank that keeps every line number honest
 *
 * `lib/checkaudit.js`'s `stripComments` collapses a whole multi-line `/* *‍/` block into a
 * single space — exactly right for "does this text mention X anywhere", wrong here, where
 * a call site's line number *is* the answer: collapsing one ten-line doc comment would
 * shift every line after it by nine. `blankNonCode` below does the same masking
 * character-by-character instead, replacing comment and string content with spaces but
 * never touching a `\n`, so `raw[i]` and `blanked[i]` describe the exact same offset in
 * the exact same file and a mismatch between them is the whole test for "is this
 * occurrence real code".
 *
 * ## A dotted target is disambiguated by its parent, not resolved by a parser
 *
 * `views.mark` has no module of its own — `mark` is a property on an object literal
 * (`window.beadcause.views = { …, mark(id) { … } }` in `public/viewbar.js`) — and `mark`
 * alone is not distinctive: this repo defines a same-named `mark` for a review pill's
 * emoji, a duplicate bead, a farblock target, four others. Neither the definition nor a
 * call site is found by name alone; both are filtered by requiring the *immediate* parent
 * segment (`views`) nearby — a preceding `\bviews\b\s*[:=]` line above the definition, or
 * an unbroken `.`/`?.` chain ending in `views` immediately before the call. That is
 * deliberately shallower than a real property-resolution parser (only the one segment
 * just before the target is checked, not the whole chain for a three-or-more-deep path)
 * — the same tradeoff `bin/b7e-def`'s own header already makes about template literals,
 * named there rather than left to be discovered.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { REPO_ROOT, SOURCE_DIRS, buildGraph, closureOf } from './affected.js';

export { REPO_ROOT, SOURCE_DIRS };

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'vendor', 'coverage']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------- file walk */

/**
 * Every JS-ish file under `SOURCE_DIRS`, repo-relative, forward-slashed — plus, like
 * `bin/b7e-def`, any extensionless file that opens with `#!/usr/bin/env node` (the
 * `bin/b7e-*` convention itself — see `only-an-extensionless-bin-resolves-on-path`), so a
 * call from inside a command such as this one is itself findable.
 */
export function listAllSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || EXCLUDE_DIR_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name);
      if (CODE_EXT.has(ext)) {
        files.push(full);
        continue;
      }
      if (!ext) {
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(32);
          const n = fs.readSync(fd, buf, 0, 32, 0);
          fs.closeSync(fd);
          if (buf.subarray(0, n).toString('utf8').startsWith('#!/usr/bin/env node')) files.push(full);
        } catch {
          /* not readable, not ours to search */
        }
      }
    }
  };
  for (const d of SOURCE_DIRS) walk(path.join(root, d));
  return files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
}

/* ------------------------------------------------------------ comment/string-safe blank */

/**
 * `text`, character for character, with every `//` line comment, `/* *‍/` block comment and
 * quoted string replaced by spaces — every `\n` left exactly where it was, so
 * `blankNonCode(text)` is always the same length as `text` and line numbers computed
 * against either one agree. Naive: a hand-rolled scanner cannot tell "a quote that closes
 * a string" from "a quote that is content of an *enclosing* string it never recognised as
 * open" — `` `<script src="/${f}">` `` inside a backtick template, found live in
 * `test/panes.mjs`, desynced this exact way and silently blanked forty real lines after
 * it as if they were string content. `blankNonCode` below is the real answer, parsed
 * with `acorn`; this stays only as its fallback for text `acorn` cannot parse at all
 * (a fixture snippet in a test, or a genuine syntax error) — worse fidelity, never wrong
 * about the file's own length or its newlines.
 */
export function blankNonCodeNaive(text) {
  const n = text.length;
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out[i] = ' ';
      i += 1;
      while (i < n && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = text[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    out[i] = c;
    i += 1;
  }
  return out.join('');
}

/**
 * Every `[start, end)` char range `blankNonCode` should replace with spaces — every
 * comment `acorn` reports, and every plain string literal and template-literal *chunk*
 * (never the `${ … }` expression between two chunks, which is real code and may itself
 * hold a call site this repo cares about — see the file header). A regex literal is left
 * alone too: `node.regex` marks it, and blanking would cost more than it protects. Acorn
 * gets this right where the hand-rolled scanner in `blankNonCodeNaive` cannot: it is the
 * same parser this repo already trusts for scope analysis in `lib/noundef.js`, not a
 * second, weaker guess at what a string boundary is.
 */
function blankRanges(text) {
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true, onComment: comments });
  } catch {
    return null;
  }
  const ranges = comments.map((c) => [c.start, c.end]);
  const seen = new Set();
  const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'Literal' && typeof node.value === 'string' && !node.regex) {
      ranges.push([node.start, node.end]);
      return;
    }
    if (node.type === 'TemplateElement') {
      ranges.push([node.start, node.end]);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
      } else if (isNode(val)) {
        walk(val);
      }
    }
  };
  walk(ast);
  return ranges;
}

/** See `blankRanges` and `blankNonCodeNaive` — this is the primary, `acorn`-backed path. */
export function blankNonCode(text) {
  const ranges = blankRanges(text);
  if (ranges === null) return blankNonCodeNaive(text);
  const out = text.split('');
  for (const [s, e] of ranges) {
    for (let i = s; i < e; i += 1) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/* --------------------------------------------------------- string/comment aware scan */
/* Ported from bin/b7e-def, unchanged in shape — see that file's header for what this
 * does not parse (multi-line strings/comments are walked correctly; template-literal
 * interpolation is treated as opaque). */

function skipString(text, i) {
  const q = text[i];
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === q) return i + 1;
    i += 1;
  }
  return i;
}

function findBody(text, fromIndex) {
  let i = fromIndex;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')' || c === ']') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === '{' && depth === 0) return { type: 'brace', index: i };
    if (c === ';' && depth === 0) return { type: 'semi', index: i };
    i += 1;
  }
  return null;
}

/**
 * Stricter than `findBody`, and only for the two head shapes that have no keyword
 * anchor (`property function`, `method`) — a bare `name(` at the start of a line is
 * exactly as consistent with a call as with a definition, and `findBody`'s "the first
 * `{` at depth 0, however far away" answers the wrong question for a call: it happily
 * walked past `openReviewAnswerSession(cfg, ws, …, {` (a call passing an object literal)
 * and matched the `{ branch: …, owner: … }` object *three arguments later*, in
 * `resolveFor`'s own argument list, as if it were this call's body. This instead
 * requires the brace to be the very next token once this name's own `(…)` actually
 * closes — which a real method definition always satisfies and a call followed by
 * anything other than its own body never does.
 */
function bodyImmediatelyAfterParens(text, fromIndex) {
  let i = fromIndex;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')' || c === ']') {
      depth -= 1;
      i += 1;
      if (depth === 0) break; // this name's own parameter list just closed
      continue;
    }
    i += 1;
  }
  if (depth !== 0) return null; // never closed — not a definition
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === '{') return { type: 'brace', index: i };
  if (text[i] === ';') return { type: 'semi', index: i };
  return null;
}

function matchBrace(text, openIndex) {
  let depth = 1;
  let i = openIndex + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return text.length - 1;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return text.length - 1;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return i - 1;
}

export function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return (charIndex) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= charIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function docCommentStart(lines, startLine) {
  let li = startLine - 2;
  while (li >= 0) {
    const t = lines[li].trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/')) {
      li -= 1;
      continue;
    }
    break;
  }
  return li + 2;
}

/** Every definition of `name` in `text` (one file's contents) — see `bin/b7e-def`'s header. */
export function definitionsFor(name, file, text) {
  const wb = `\\b${escapeRe(name)}\\b`;
  const heads = [
    { re: new RegExp(`^export\\s+default\\s+(async\\s+)?function\\*?\\s+${wb}\\s*\\(`), label: 'export default function' },
    { re: new RegExp(`^export\\s+(async\\s+)?function\\*?\\s+${wb}\\s*\\(`), label: 'export function' },
    { re: new RegExp(`^export\\s+class\\s+${wb}\\b`), label: 'export class' },
    { re: new RegExp(`^export\\s+(const|let|var)\\s+${wb}\\s*=`), label: 'export' },
    { re: new RegExp(`^(async\\s+)?function\\*?\\s+${wb}\\s*\\(`), label: 'function' },
    { re: new RegExp(`^class\\s+${wb}\\b`), label: 'class' },
    { re: new RegExp(`^(const|let|var)\\s+${wb}\\s*=`), label: 'variable' },
    { re: new RegExp(`^${wb}\\s*:\\s*(async\\s+)?function\\*?\\s*\\(`), label: 'property function', verifyBody: true },
    { re: new RegExp(`^(static\\s+)?(async\\s+)?(get\\s+|set\\s+)?\\*?${wb}\\s*\\(`), label: 'method', verifyBody: true },
  ];
  const lines = text.split('\n');
  const idx = lineIndexer(text);
  const out = [];
  let charOffset = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const trimmed = line.trimStart();
    const leadingWs = line.length - trimmed.length;
    for (const head of heads) {
      const m = head.re.exec(trimmed);
      if (!m) continue;
      const afterHeadChar = charOffset + leadingWs + m[0].length - 1;
      const body = head.verifyBody ? bodyImmediatelyAfterParens(text, afterHeadChar) : findBody(text, afterHeadChar);
      if (!body) continue;
      if (head.verifyBody && body.type !== 'brace') continue;
      const endIndex = body.type === 'brace' ? matchBrace(text, body.index) : body.index;
      const startLine = li + 1;
      const endLine = idx(endIndex);
      const docStart = docCommentStart(lines, startLine);
      out.push({ file, startLine, endLine, docStart, label: head.label });
      break;
    }
    charOffset += line.length + 1;
  }
  return out;
}

/** Every `import ... name ... from '<specifier>'` binding of `name` in `text`. */
export function importsFor(name, file, text) {
  const idx = lineIndexer(text);
  const out = [];
  const re = /import\s+([^;]*?)\s+from\s+(['"])((?:(?!\2).)*)\2/gs;
  let m;
  while ((m = re.exec(text))) {
    const clause = m[1];
    const specifier = m[3];
    const clauseStart = m.index + m[0].indexOf(clause);
    const bindings = [];
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) bindings.push({ local: ns[1], real: '*' });
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const as = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (as) bindings.push({ local: as[2], real: as[1] });
        else bindings.push({ local: p, real: p });
      }
    }
    const before = named ? clause.slice(0, named.index) : ns ? '' : clause;
    const def = before.match(/^([A-Za-z_$][\w$]*)/);
    if (def) bindings.push({ local: def[1], real: 'default' });

    for (const b of bindings) {
      if (b.local !== name) continue;
      const localOffset = clause.search(new RegExp(`\\b${escapeRe(name)}\\b`));
      const charIndex = localOffset >= 0 ? clauseStart + localOffset : m.index;
      out.push({ file, line: idx(charIndex), specifier, real: b.real });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- targets */

/**
 * How to read the CLI's one positional argument — see the file header for why each shape
 * exists: `<module>#<export>` pins a definition to one file when a name is ambiguous,
 * `<path>` (a slash, or a `.js`/`.mjs`/`.cjs` suffix, that actually resolves under `root`)
 * asks the module-graph question instead of the symbol question, `a.b` disambiguates a
 * property by its immediate parent, and anything else is a bare identifier.
 */
export function parseTarget(root, raw) {
  if (raw.includes('#')) {
    const i = raw.indexOf('#');
    const module = raw.slice(0, i);
    const name = raw.slice(i + 1);
    return { kind: 'qualified', module, name };
  }
  if (/[\\/]/.test(raw) || /\.(m?js|cjs)$/.test(raw)) {
    const rel = raw.replace(/^\.\//, '');
    if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) {
      return { kind: 'module', module: rel };
    }
  }
  if (raw.includes('.')) {
    const segments = raw.split('.').filter(Boolean);
    if (segments.length >= 2) {
      return {
        kind: 'dotted',
        name: segments[segments.length - 1],
        parentSegment: segments[segments.length - 2],
        segments,
      };
    }
  }
  return { kind: 'plain', name: raw };
}

/** Does `file` (searched near `startLine`, looking upward) declare `parentSegment` nearby? */
function hasNearbyParent(root, def, parentSegment) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, def.file), 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  const re = new RegExp(`\\b${escapeRe(parentSegment)}\\b\\s*[:=]`);
  const from = Math.max(0, def.startLine - 200);
  for (let li = from; li < def.startLine - 1; li += 1) {
    if (re.test(lines[li])) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- occurrences */

const BOUNDARY_RE = /[;{}(),=\n]/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Is `windowText` (the raw text just before a match) a `.`/`?.` chain ending in `parent`? */
function chainEndsWith(windowText, parent) {
  let cut = -1;
  for (let i = windowText.length - 1; i >= 0; i -= 1) {
    if (BOUNDARY_RE.test(windowText[i])) {
      cut = i;
      break;
    }
  }
  const scoped = cut === -1 ? windowText : windowText.slice(cut + 1);
  const idents = scoped
    .split(/\?\./)
    .join('.')
    .split('.')
    .map((t) => t.trim())
    .filter((t) => IDENT_RE.test(t));
  return idents.length > 0 && idents[idents.length - 1] === parent;
}

function isCallish(text, fromIndex) {
  const n = text.length;
  let i = fromIndex;
  while (i < n && /\s/.test(text[i])) i += 1;
  if (text[i] === '?' && text[i + 1] === '.') {
    i += 2;
    while (i < n && /\s/.test(text[i])) i += 1;
  }
  return text[i] === '(';
}

const IMPORT_LINE_RE = /^\s*(import|export)\b.*\bfrom\s+['"]/;

// `const { a, b } = await import(LIB('x.js'))` — this repo's own dynamic-import
// convention (see `lib/affected.js`'s header), and it destructures across several
// lines as often as not, so a same-line check like `IMPORT_LINE_RE` misses most of
// it. Matched separately from a static `import { a, b } from '...'` (which can also
// wrap lines) so both land on the char ranges of their own `{ ... }` binding list.
const STATIC_IMPORT_BRACE_RE = /\bimport\s*\{([\s\S]*?)\}\s*from\s+['"]/g;
const DESTRUCTURE_IMPORT_BRACE_RE = /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g;

/** Char ranges `[start, end)` of every `{ ... }` binding list of an import, static or dynamic. */
function importBindingRanges(text) {
  const ranges = [];
  for (const re of [STATIC_IMPORT_BRACE_RE, DESTRUCTURE_IMPORT_BRACE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const braceStart = m.index + m[0].indexOf('{');
      ranges.push([braceStart, braceStart + 1 + m[1].length]);
    }
  }
  return ranges;
}

const inRanges = (ranges, pos) => ranges.some(([a, b]) => pos >= a && pos < b);

/**
 * Every occurrence of `target.name` in `files` (repo-relative, under `root`) — a `call`
 * (followed, possibly through `?.`, by `(`), an `import` (bound in a static `import { … }
 * from '…'` clause or this repo's `{ … } = await import(…)` convention, either one
 * possibly spanning several lines), a `comment` (the match sits where `blankNonCode`
 * differs from the raw text — inside a comment or a string literal), or a bare
 * `reference` (real code, but not a call). `target.parentSegment`, when given, drops any
 * occurrence whose immediately preceding `.`/`?.` chain does not end in it — see the file
 * header on why a dotted target needs that.
 */
export function occurrencesFor(root, files, target) {
  const wb = new RegExp(`\\b${escapeRe(target.name)}\\b`, 'g');
  const out = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const blanked = blankNonCode(raw);
    const idx = lineIndexer(raw);
    const lines = raw.split('\n');
    const importRanges = importBindingRanges(raw);
    wb.lastIndex = 0;
    let m;
    while ((m = wb.exec(raw))) {
      const start = m.index;
      const end = start + m[0].length;
      if (target.parentSegment && !chainEndsWith(raw.slice(Math.max(0, start - 240), start), target.parentSegment)) {
        continue;
      }
      const line = idx(start);
      const lineText = lines[line - 1].trim();
      const inCode = blanked[start] === raw[start];
      let kind;
      if (!inCode) {
        kind = 'comment';
      } else if (IMPORT_LINE_RE.test(lines[line - 1]) || inRanges(importRanges, start)) {
        kind = 'import';
      } else if (isCallish(blanked, end)) {
        kind = 'call';
      } else {
        kind = 'reference';
      }
      out.push({ file, line, text: lineText, kind });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- verdict */

/**
 * One line: `wired (N call sites)` when a real call exists outside every file the symbol
 * is defined in; `no caller outside its own file` when every call is internal to a
 * definition's own file; `mentioned only in comments` when there is no call anywhere but
 * a comment names it; `referenced, but never called` for a bare mention with no call and
 * no comment; `no reference found anywhere searched` — never a shrug, always one of these.
 */
export function verdictFor(ownFiles, occurrences) {
  const calls = occurrences.filter((o) => o.kind === 'call');
  const externalCalls = calls.filter((o) => !ownFiles.has(o.file));
  if (externalCalls.length) {
    return `wired (${externalCalls.length} call site${externalCalls.length === 1 ? '' : 's'})`;
  }
  if (calls.length) return 'no caller outside its own file';
  if (occurrences.some((o) => o.kind === 'comment')) return 'mentioned only in comments';
  if (occurrences.some((o) => o.kind === 'reference' || o.kind === 'import')) return 'referenced, but never called';
  return 'no reference found anywhere searched';
}

/* -------------------------------------------------------------- module graph */

/**
 * The module-graph half: what `modulePath` imports, what imports it, and — the question
 * `bc-36xx.24`'s acceptance names — which files it does *not yet* import that already
 * (transitively) import *it*, so that a new edge from `modulePath` to any of them would
 * close a cycle. A file already directly imported is not in that list: importing it again
 * is not a new edge, and it cannot both be imported by `modulePath` and reach `modulePath`
 * without a cycle already existing today.
 */
export function moduleReport(root, modulePath) {
  const { forward } = buildGraph(root);
  if (!forward.has(modulePath)) {
    return { module: modulePath, error: `not a known source file under ${SOURCE_DIRS.join('/')}` };
  }
  const imports = [...(forward.get(modulePath) || [])].sort();
  const importSet = new Set(imports);
  const importedBy = [];
  for (const [file, deps] of forward) {
    if (deps.has(modulePath)) importedBy.push(file);
  }
  importedBy.sort();

  const cache = new Map();
  const ownClosure = closureOf(forward, modulePath, cache);
  const transitiveImports = [...ownClosure].filter((f) => f !== modulePath).sort();

  const wouldCloseCycleIfImported = [];
  for (const file of forward.keys()) {
    if (file === modulePath || importSet.has(file)) continue;
    if (closureOf(forward, file, cache).has(modulePath)) wouldCloseCycleIfImported.push(file);
  }
  wouldCloseCycleIfImported.sort();

  return {
    module: modulePath,
    imports,
    importedBy,
    transitiveImportCount: transitiveImports.length,
    transitiveImports,
    wouldCloseCycleIfImported,
  };
}

/* -------------------------------------------------------------------- the answer */

/**
 * The whole answer for one root and one raw CLI argument. `opts.tests` (default `false`)
 * includes `test/` in the symbol search — off by default because that is the scoping
 * `bc-36xx.5`'s own history got wrong (see the file header), and matches this bead's own
 * acceptance case for `approvedReview`.
 */
export function findCallers(root, rawTarget, opts = {}) {
  const includeTests = !!opts.tests;
  const target = parseTarget(root, rawTarget);

  if (target.kind === 'module') {
    return { kind: 'module', target: rawTarget, report: moduleReport(root, target.module) };
  }

  const allFiles = listAllSourceFiles(root);
  const searchFiles = includeTests ? allFiles : allFiles.filter((f) => !f.startsWith('test/'));

  let defs = [];
  for (const f of allFiles) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    let found = definitionsFor(target.name, f, text);
    if (target.kind === 'qualified') found = found.filter(() => f === target.module);
    defs.push(...found);
  }
  if (target.kind === 'dotted') {
    const withParent = defs.filter((d) => hasNearbyParent(root, d, target.parentSegment));
    if (withParent.length) defs = withParent;
  }
  defs.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);

  const ownFiles = new Set(defs.map((d) => d.file));
  const skip = new Map();
  for (const d of defs) {
    const set = skip.get(d.file) || new Set();
    for (let l = d.docStart; l <= d.endLine; l += 1) set.add(l);
    skip.set(d.file, set);
  }

  const occTarget = target.kind === 'dotted' ? { name: target.name, parentSegment: target.parentSegment } : { name: target.name };
  const occurrences = occurrencesFor(root, searchFiles, occTarget).filter((o) => !(skip.get(o.file) || new Set()).has(o.line));

  return {
    kind: target.kind,
    target: rawTarget,
    name: target.name,
    module: target.module || null,
    definitions: defs,
    occurrences,
    verdict: verdictFor(ownFiles, occurrences),
  };
}
