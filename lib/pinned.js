/**
 * `b7e-pinned` — which `test/*.mjs` assertions are pinned to the exact words of a
 * module's generated prose, so a rewrap or a rewording can be checked against the list
 * before it ships rather than after a suite goes red.
 *
 * bc-khoe.27.12 is the audit: three sessions (bc-bmry.8, bc-bmry.7, bc-xl7n.99) each
 * edited a generated brief by hand — lib/session.js's `workPromptFor`,
 * lib/epicadvocate.js's `epicAdvocatePrompt` — and each learned which words were
 * load-bearing by breaking one and reading the failure: a guessed `grep -rn "a\|b\|c"`
 * that still shipped a red, a count baked into a regex nobody remembered was there, four
 * corrective `Edit`s narrated "let me clean this up properly". This is the read that
 * would have replaced all three.
 *
 * WHAT COUNTS AS "ASSERTED AGAINST THIS MODULE'S OUTPUT". Not every literal in a suite
 * that happens to import the module — test/onelaw.mjs imports lib/session.js alongside
 * lib/approval.js, lib/bd.js, lib/owed.js and lib/mergequeue.js, and a literal about a
 * merge-queue label is not pinned to session.js's prose. So this traces which *local
 * names* actually hold the module's output: the module's own exports, plus —
 * transitively, to a bounded depth — any local `const NAME = …` whose right-hand side
 * calls one of them. That is the one-hop indirection test/onelaw.mjs's own `briefFor`
 * is: `const briefFor = (labels) => workPromptFor(…)`. Only an assertion call
 * (`assert.match`/`equal`/`strictEqual`/`deepEqual`/`deepStrictEqual`/`ok`, a bare
 * `.test(`, a bare `.includes(`) whose statement mentions one of those names is read
 * for a pinned literal.
 *
 * WHAT THIS DOES NOT DO. It is not a JS parser. Statements are split by
 * lib/harness.js's `statements()` — bracket-depth over the comment-blanked source, the
 * same splitter the house test-shape tool already trusts — and calls are found and
 * their arguments split by a small hand-rolled tokenizer below, not a real AST. A local
 * name is only ever traced by *name*, never by import alias — `const { workPromptFor:
 * wpf }` would be missed, because nothing in this corpus renames an import that way
 * today. A suite that builds its pinned literal across a ternary, a template
 * expression, or a helper called three names deep will not be found either. That is
 * the same bound b7e-owes documents for its own regexes, and it fails in the quiet
 * direction: a literal it misses is one you still have to grep for by hand, not one it
 * lies about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { blankComments } from './evidence.js';
import { blankLiterals, statements } from './harness.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|of|in|do|else|await|yield)$/;
const ASSERT_2ARG = new Set(['match', 'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);

/* ===================================================================== *
 * a small tokenizer — string/regex/template literals and bracket punctuation, over one
 * statement's text at a time. The literal-boundary rules (which `/` opens a regex
 * rather than divides, which backslash is an escape) are the same ones lib/harness.js's
 * `blankLiterals` already worked out for this repo; this is that scan adapted to
 * *collect* tokens instead of blanking them, because both `literalsIn` and `splitArgs`
 * below need the same boundaries.
 * ===================================================================== */

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let last = '';
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== c) {
        i += text[i] === '\\' ? 2 : 1;
      }
      const closed = text[i] === c;
      if (closed) i += 1;
      tokens.push({ type: 'string', raw: text.slice(start, i), index: start, closed });
      last = c;
      continue;
    }
    if (c === '`') {
      const start = i;
      i += 1;
      let holes = 0;
      let brace = 0;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '$' && text[i + 1] === '{') {
          holes += 1;
          i += 2;
          continue;
        }
        if (holes > 0 && d === '{') {
          brace += 1;
          i += 1;
          continue;
        }
        if (holes > 0 && d === '}') {
          if (brace > 0) brace -= 1;
          else holes -= 1;
          i += 1;
          continue;
        }
        if (d === '`' && holes === 0) break;
        i += 1;
      }
      const closed = text[i] === '`';
      if (closed) i += 1;
      tokens.push({ type: 'template', raw: text.slice(start, i), index: start, closed });
      last = '`';
      continue;
    }
    if (c === '/' && (REGEX_AFTER.has(last) || REGEX_KEYWORD.test(text.slice(0, i)))) {
      const start = i;
      let j = i + 1;
      let klass = false;
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') klass = true;
        else if (d === ']') klass = false;
        else if (d === '/' && !klass) {
          closed = true;
          break;
        } else if (d === '\n') break;
        j += 1;
      }
      if (closed) {
        j += 1; // the closing '/'
        while (j < text.length && /[a-z]/i.test(text[j])) j += 1; // flags
        tokens.push({ type: 'regex', raw: text.slice(start, j), index: start, closed: true });
        i = j;
        last = '/';
        continue;
      }
      // not actually a regex on this line — fall through and treat '/' as ordinary
    }
    if ('()[]{},'.includes(c)) {
      tokens.push({ type: 'punct', raw: c, index: i });
      i += 1;
      last = c;
      continue;
    }
    if (c.trim()) last = c;
    i += 1;
  }
  return tokens;
}

/**
 * Every string/regex/template literal in `text`, left to right: `{kind, raw, content,
 * index}`. `content` is the part between the delimiters — for a regex, flags stripped
 * off it separately — unescaped not at all, which is good enough for a substring or
 * pattern check and keeps the offsets exact.
 */
export function literalsIn(text) {
  return tokenize(text)
    .filter((t) => t.type !== 'punct')
    .map((t) => {
      if (t.type === 'regex') {
        const flagMatch = t.raw.match(/\/([a-z]*)$/i);
        const flags = flagMatch ? flagMatch[1] : '';
        const content = t.closed ? t.raw.slice(1, t.raw.length - flags.length - 1) : t.raw.slice(1);
        return { kind: 'regex', raw: t.raw, content, flags, index: t.index };
      }
      const content = t.closed ? t.raw.slice(1, -1) : t.raw.slice(1);
      return { kind: t.type, raw: t.raw, content, index: t.index };
    });
}

function matchingClose(tokens, openTokIdx) {
  let depth = 0;
  for (let k = openTokIdx + 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== 'punct') continue;
    if (t.raw === '(' || t.raw === '[' || t.raw === '{') depth += 1;
    else if (t.raw === ')' || t.raw === ']' || t.raw === '}') {
      if (depth === 0) return k;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Split the arguments of the call whose `(` is at `openIndex` in `text` — literal- and
 * nesting-aware, so a comma inside a string, a regex character class or a nested call
 * does not split an argument in two. Returns `{args: [{text, index}], closeIndex}`;
 * `closeIndex` is `-1` if the call never closes inside `text` (should not happen for a
 * call found inside one of `statements()`'s already bracket-balanced statements).
 */
export function splitArgs(text, openIndex) {
  const tokens = tokenize(text);
  const openTokIdx = tokens.findIndex((t) => t.type === 'punct' && t.raw === '(' && t.index === openIndex);
  if (openTokIdx === -1) return { args: [], closeIndex: -1 };
  const args = [];
  let depth = 0;
  let argStart = openIndex + 1;
  for (let k = openTokIdx + 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== 'punct') continue;
    if (t.raw === '(' || t.raw === '[' || t.raw === '{') {
      depth += 1;
      continue;
    }
    if (t.raw === ')') {
      if (depth === 0) {
        const seg = text.slice(argStart, t.index);
        if (seg.trim()) args.push({ text: seg, index: argStart });
        return { args, closeIndex: t.index };
      }
      depth -= 1;
      continue;
    }
    if (t.raw === ']' || t.raw === '}') {
      depth -= 1;
      continue;
    }
    if (t.raw === ',' && depth === 0) {
      const seg = text.slice(argStart, t.index);
      if (seg.trim()) args.push({ text: seg, index: argStart });
      argStart = t.index + 1;
    }
  }
  return { args, closeIndex: -1 };
}

/**
 * `statements()` ends a statement the moment a line's own brackets net to zero, which
 * is right for `foo(\n  a,\n  b,\n);` but wrong for `const NAME = (x) =>` — the arrow's
 * `(x)` already nets to zero on its own line, so the assignment and its body split
 * into two "statements" and a `const NAME = …` decl reads as having no right-hand side
 * at all. Glued back together here: a statement whose trimmed text ends in something
 * that cannot end a real statement (`=>`, an operator, a trailing comma) is merged with
 * the next one, repeatedly, until it ends in something that can.
 */
const CONTINUES = /(=>|&&|\|\||\?\?|[,+\-*/%^&|<>=~]|\bawait|\breturn)\s*$/;
function mergeContinuations(stmts) {
  const out = [];
  let i = 0;
  while (i < stmts.length) {
    let cur = stmts[i];
    let j = i + 1;
    while (j < stmts.length && CONTINUES.test(cur.text.trimEnd())) {
      cur = { text: `${cur.text}\n${stmts[j].text}`, start: cur.start, end: stmts[j].end };
      j += 1;
    }
    out.push(cur);
    i = j;
  }
  return out;
}

/* ===================================================================== *
 * which local names hold this module's output
 * ===================================================================== */

/** Every top-level `export function|const|let NAME` in a module's source. */
export function moduleExports(source) {
  const code = blankComments(String(source));
  const names = new Set();
  for (const m of code.matchAll(/\bexport\s+(?:async\s+function|function|const|let)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Names bound by a `{a, b: c}` / `[a, b]` / plain destructure pattern's own text (no braces stripped twice). */
function destructuredNames(pattern) {
  const p = pattern.trim();
  if (!p.startsWith('{') && !p.startsWith('[')) return [p];
  return p
    .slice(1, -1)
    .split(',')
    .map((part) => {
      const piece = part.trim();
      if (!piece) return null;
      const named = piece.includes(':') ? piece.split(':')[1].trim() : piece;
      return named.replace(/=.*$/, '').trim() || null;
    })
    .filter(Boolean);
}

/**
 * `{names, rhs}` for whatever this statement's leading declaration binds and what it
 * binds it *from* — a plain `const NAME = …`, a `const {a, b} = …` / `const [a, b] =
 * …` destructure, or a `for (const [a, b] of …)` loop header, which is how
 * test/land.mjs walks its three endings against one shared block of assertions.
 */
function declarationIn(codeOnly) {
  let m = /^\s*for\s*\(\s*(?:const|let)\s*(\{[^}]*\}|\[[^\]]*\])\s+of\s+([\s\S]*)$/.exec(codeOnly);
  if (m) return { names: destructuredNames(m[1]), rhs: m[2] };
  m = /^\s*(?:export\s+)?(?:const|let)\s*(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/.exec(codeOnly);
  if (m) return { names: destructuredNames(m[1]), rhs: m[2] };
  return null;
}

/**
 * `seed` grown to a bounded depth: any name a statement declares or destructures joins
 * the set too, once whatever it is declared *from* already mentions an existing holder
 * — a bare mention, not necessarily a call, because both a local wrapper
 * (`const briefFor = (labels) => workPromptFor(…)`) and a plain re-binding
 * (`for (const [name, brief] of [['x', land], …])`, test/land.mjs's own shape for
 * walking three endings against one shared block of assertions) have to grow the set
 * the same way. Bounded to six passes so a cycle — which valid JS assignment order
 * cannot produce, but nothing here proves that — cannot loop forever.
 */
export function deriveHolders(stmts, seed) {
  const holders = new Set(seed);
  for (let pass = 0; pass < 6; pass += 1) {
    let grew = false;
    for (const st of stmts) {
      const decl = declarationIn(blankLiterals(st.text));
      if (!decl) continue;
      const rhs = decl.rhs;
      for (const h of holders) {
        if (!new RegExp(`\\b${escapeRe(h)}\\b`).test(rhs)) continue;
        for (const name of decl.names) {
          if (!holders.has(name)) {
            holders.add(name);
            grew = true;
          }
        }
        break;
      }
    }
    if (!grew) break;
  }
  return holders;
}

/* ===================================================================== *
 * assertion calls and which of their arguments is the pinned one
 * ===================================================================== */

// `assert.ok(…)` is deliberately not a call kind of its own: its boolean expression is
// almost always `X.includes('…')` or `/…/.test(X)`, sometimes negated, and both of
// those are already found here as calls in their own right wherever they appear —
// nested inside `assert.ok(…)` or not. Reading `assert.ok`'s own argument on top of
// that would report the same literal twice for `assert.ok(x.includes('…'))`, which
// bc-khoe.27.12's own corpus does often (test/epicadvocate.mjs, repeatedly). The
// direct-equality shape `assert.ok(x === '…')` is the cost of leaving it out — a
// literal it misses, not one it lies about.
function findCalls(codeOnly) {
  const calls = [];
  for (const m of codeOnly.matchAll(/\bassert(?:\.strict)?\.(match|equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g)) {
    calls.push({ method: m[1], openIndex: m.index + m[0].length - 1 });
  }
  for (const m of codeOnly.matchAll(/\.test\s*\(/g)) {
    calls.push({ method: 'test', openIndex: m.index + m[0].length - 1, dotIndex: m.index });
  }
  for (const m of codeOnly.matchAll(/\.includes\s*\(/g)) {
    calls.push({ method: 'includes', openIndex: m.index + m[0].length - 1 });
  }
  return calls;
}

/** The literal(s) `call` pins, from the real (comment-blanked, literal-preserving) `text`. */
function pinnedFromCall(text, call) {
  if (call.method === 'test') {
    // The pinned literal is the regex literal the call is a method of — `/…/.test(x)` —
    // found by its own token ending exactly where `.test(` begins, not by argument.
    const before = text.slice(0, call.dotIndex);
    const lits = literalsIn(text);
    const receiver = lits.find((l) => l.kind === 'regex' && l.index + l.raw.length === before.length);
    return receiver ? [receiver] : [];
  }
  const { args, closeIndex } = splitArgs(text, call.openIndex);
  if (closeIndex === -1) return [];
  if (ASSERT_2ARG.has(call.method)) {
    if (args.length < 2) return [];
    return literalsIn(args[1].text).map((l) => ({ ...l, index: l.index + args[1].index }));
  }
  if (call.method === 'includes') {
    if (args.length < 1) return [];
    return literalsIn(args[0].text).map((l) => ({ ...l, index: l.index + args[0].index }));
  }
  return [];
}

/* ===================================================================== *
 * the report
 * ===================================================================== */

// Digits, and the spelled-out counts this repo's prose actually uses — the bead's own
// example is `/four honest endings/`, a count with no digit in it at all, which is
// exactly the shape that breaks silently on the fifth ending and nothing about `\d`
// would ever catch.
const NUMBER_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const hasNumber = (content) => /\d/.test(content) || NUMBER_WORD.test(content);

/** Does `pattern` (a regex source + flags) match `sourceText` today? False on a bad pattern. */
function regexAppearsIn(content, flags, sourceText) {
  try {
    return new RegExp(content, flags.replace(/[gy]/g, '')).test(sourceText);
  } catch {
    return false;
  }
}

/**
 * Every literal in `test/*.mjs` asserted against `moduleBasename`'s output, grouped by
 * suite. `builder`, if given, narrows the seed to that one export instead of every
 * export the module has.
 */
export function pinnedIn(root, moduleBasename, moduleSource, { builder = null } = {}) {
  const testDir = path.join(root, 'test');
  let files;
  try {
    files = fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs')).sort();
  } catch {
    files = [];
  }
  const exportNames = moduleExports(moduleSource);
  const seed = builder ? new Set([builder]) : exportNames;
  const suites = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(testDir, file), 'utf8');
    const blanked = blankComments(raw);
    if (!blanked.includes(moduleBasename)) continue;
    const stmts = mergeContinuations(statements(blanked));
    const holders = deriveHolders(stmts, seed);
    const findings = [];
    for (const st of stmts) {
      const codeOnly = blankLiterals(st.text);
      const mentionsHolder = [...holders].some((h) => new RegExp(`\\b${escapeRe(h)}\\b`).test(codeOnly));
      if (!mentionsHolder) continue;
      for (const call of findCalls(codeOnly)) {
        for (const lit of pinnedFromCall(st.text, call)) {
          if (lit.kind === 'template') continue; // no fixed words to pin
          const before = st.text.slice(0, lit.index);
          const line = st.start + (before.match(/\n/g) || []).length + 1;
          const inSource =
            lit.kind === 'regex' ? regexAppearsIn(lit.content, lit.flags, moduleSource) : moduleSource.includes(lit.content);
          const hasNewline = lit.kind === 'regex' ? /\\n/.test(lit.raw) : lit.content.includes('\n');
          findings.push({ line, kind: lit.kind, raw: lit.raw, inSource, hasNewline, hasNumber: hasNumber(lit.content) });
        }
      }
    }
    if (findings.length) {
      findings.sort((a, b) => a.line - b.line);
      suites.push({ file, findings });
    }
  }
  return suites;
}
