/**
 * `b7e-bd` — which call does *this* to a bead: the `Bd` wrapper method, the exact `bd`
 * argv it spawns, and what the bd actually installed here advertises for that
 * subcommand. bc-dgx7.20, filed by the session audit (lib/sessionaudit.js) over five
 * sessions that each spent real time on the same hunt: `bd --version`, `bd --help`,
 * `bd update --help | grep -i parent`, four greps through `lib/bd.js` for a method name
 * guessed from the intent. The answers are load-bearing and easy to get wrong —
 * `Bd.addLabel` is `bd label add <id> <label>`, id first, label last — and this repo
 * already keeps hand-written `beadcause-memory` notes about exactly this ("bd-show-
 * takes-a-list-of-ids"), which is a library note waiting for a command to surface it.
 *
 * **Two questions, one command.** Given an intent — `label`, `reparent`, `close force`,
 * `lease` — this answers "which `Bd` method wraps that" (searched by name and doc,
 * reusing `lib/already.js`'s exact convention — see below for why that matters) *and*
 * "what does the raw `bd` binary installed on this machine call that" (searched over
 * every top-level subcommand's own `--help` text, not just its one-line summary). A
 * caller who already knows the method name skips straight to it with `--method`.
 *
 * **Why the raw-bd search has to read full `--help` text and not just the one-line
 * summary.** `bd --help`'s own one-liner for `update` is "Update one or more issues." —
 * no mention of a parent anywhere. Its `--parent` flag's *own* description reads "New
 * parent issue ID (**reparents** the issue, use empty string to remove parent)" — and
 * that word only exists in the flag text, one level down. Matching only the top-line
 * summary would answer "reparent" with nothing; fetching every subcommand's full
 * `--help` (still under two seconds for ~50 of them) is what makes the acceptance case
 * in the bead — `b7e-bd reparent` naming `bd update --parent` — findable generically,
 * with no hand-maintained synonym table and no help this tool has to keep in sync with
 * the next `bd` release by hand.
 *
 * **Why the Bd-method search is a straight re-use of `lib/already.js`, not a new
 * scorer.** `scoreEntry`'s rule is "does the query word appear, as a substring, in the
 * entry's name or the *first line* of its doc comment" — and that first-line rule is
 * what keeps `Bd.graph()` from wrongly answering "reparent": its doc comment does say,
 * eleven paragraphs down, "the thing being cached moves only when somebody deliberately
 * *reparents* a bead" — but that sentence is not the first line, `docCommentBefore`
 * never reads that far, and the bead's own acceptance ("reparent... reports that no Bd
 * method wraps it") depends on that being true. Reusing the existing function rather
 * than writing a second, subtly different one is what keeps that guarantee real instead
 * of accidental.
 *
 * **The argv is read out of the source, never executed.** Most `Bd` methods call
 * `this.run(workspace, [literal, array, id], { retries: N })` directly, and that literal
 * array is resolved element by element: a string `Literal` prints as itself, an
 * `Identifier` (a parameter — `id`, `label`) prints as `<id>`, `<label>`, anything more
 * exotic (a template literal, a nested call) falls back to its own source text. A
 * handful of methods (`update`, `create`, `closeAnswered`, `adopt`'s siblings) build the
 * argv into a local `const args = [...]` and grow it with conditional `args.push(...)`
 * calls through the body — `update`'s never touches `--parent` at all, which is the
 * other half of why "reparent" finds nothing here. Those are resolved too: the base
 * array plus every conditional push, each labelled with the `if`/`for` that guards it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';
import { moduleSurface, scoreEntry } from './already.js';

export { scoreEntry };

const ECMA_VERSION = 2022;
export const BD_SOURCE_REL = 'lib/bd.js';
export const BD_CLASS_NAME = 'Bd';

function parseSource(source) {
  return acorn.parse(source, { ecmaVersion: ECMA_VERSION, sourceType: 'module', locations: true, ranges: true });
}

/**
 * Every node in `node`, depth-first, each visited with the stack of its ancestors (not
 * including itself) — a plain structural walk over whatever acorn actually produced,
 * the same shape `lib/imports.js`'s `collectIdentifierNames` uses for the same reason: a
 * hand-written recursive descent over one file's AST is cheaper and clearer than pulling
 * in a walker dependency for it.
 */
function walkPath(node, ancestors, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) walkPath(el, ancestors, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (val && typeof val === 'object') walkPath(val, nextAncestors, visit);
  }
}

/** Every top-level `const NAME = <number>` in a `Program` body — `SWEEP_RETRIES`,
 * `DOLT_LOCK_RETRIES` and their kin, so a call site's `{ retries: SWEEP_RETRIES }`
 * resolves to the number a reader actually cares about. */
function numericConsts(programBody) {
  const map = new Map();
  for (const stmt of programBody) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier' && d.init && d.init.type === 'Literal' && typeof d.init.value === 'number') {
        map.set(d.id.name, d.init.value);
      }
    }
  }
  return map;
}

/** One argv element, as it would print: a literal string as itself, an identifier as
 * `<name>` (a parameter the caller supplies), anything else as its own source text. */
function elementText(source, node) {
  if (node.type === 'Literal') return { text: String(node.value), placeholder: false };
  if (node.type === 'Identifier') return { text: `<${node.name}>`, placeholder: true };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { text: node.quasis.map((q) => q.value.cooked).join(''), placeholder: false };
  }
  return { text: source.slice(node.start, node.end), placeholder: true };
}

function resolveArrayLiteral(source, arrNode) {
  const argv = [];
  let dynamic = false;
  for (const el of arrNode.elements) {
    if (!el) {
      argv.push('<?>');
      dynamic = true;
      continue;
    }
    if (el.type === 'SpreadElement') {
      argv.push(`...${source.slice(el.argument.start, el.argument.end)}`);
      dynamic = true;
      continue;
    }
    const { text, placeholder } = elementText(source, el);
    argv.push(text);
    if (placeholder) dynamic = true;
  }
  return { argv, dynamic };
}

/** The nearest `const <varName> = [...]` declared before `beforePos` inside `bodyNode` —
 * `update`'s `const args = ['update', id];` is exactly this shape. */
function findDeclarator(bodyNode, varName, beforePos) {
  let best = null;
  walkPath(bodyNode, [], (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (node.id.type !== 'Identifier' || node.id.name !== varName) return;
    if (node.start >= beforePos) return;
    if (!best || node.start > best.start) best = node;
  });
  return best;
}

/** Every `<varName>.push(...)` in `bodyNode`, each with the nearest governing
 * `if`/`for-of`/`for-in` it sits directly under — `if (title) args.push('--title',
 * String(title))` becomes `{ guard: "if (title)", args: ['--title', 'String(title)'] }`.
 * Stops at a nested function boundary rather than reading a guard from outside it. */
function pushesFor(source, bodyNode, varName) {
  const out = [];
  walkPath(bodyNode, [], (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed) return;
    if (callee.object.type !== 'Identifier' || callee.object.name !== varName) return;
    if (callee.property.name !== 'push') return;
    const args = node.arguments.map((a) => elementText(source, a).text);
    let guard = null;
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const anc = ancestors[i];
      if (anc.type === 'FunctionExpression' || anc.type === 'ArrowFunctionExpression' || anc.type === 'FunctionDeclaration') break;
      if (anc.type === 'IfStatement') {
        guard = `if (${source.slice(anc.test.start, anc.test.end)})`;
        break;
      }
      if (anc.type === 'ForOfStatement' || anc.type === 'ForInStatement') {
        const kw = anc.type === 'ForOfStatement' ? 'of' : 'in';
        guard = `for (${source.slice(anc.left.start, anc.left.end)} ${kw} ${source.slice(anc.right.start, anc.right.end)})`;
        break;
      }
    }
    out.push({ guard, args });
  });
  return out;
}

function retriesOf(optsNode, constMap) {
  if (!optsNode || optsNode.type !== 'ObjectExpression') return 0;
  for (const prop of optsNode.properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
    if (key !== 'retries') continue;
    const v = prop.value;
    if (v.type === 'Literal' && typeof v.value === 'number') return v.value;
    if (v.type === 'Identifier') return constMap.has(v.name) ? constMap.get(v.name) : v.name;
    return null;
  }
  return 0;
}

/** Every `this.run(workspace, ..., opts)` / `this.json(workspace, ..., opts)` call
 * directly inside one method's body, each resolved to its bd argv, whether it retries,
 * and — for the handful built from a local accumulator — every conditional push that
 * can add to it. */
function callSitesIn(source, fnNode, constMap) {
  const sites = [];
  walkPath(fnNode.body, [], (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed) return;
    if (callee.object.type !== 'ThisExpression') return;
    const bdCall = callee.property.name;
    if (bdCall !== 'run' && bdCall !== 'json') return;
    const argsNode = node.arguments[1];
    if (!argsNode) return;

    let argv = [];
    let dynamic = false;
    let pushes = null;
    let note = null;
    // Which identifier the argv is actually built from: the array literal itself, a
    // plain `args` reference, or — `create`'s second call — `args.filter(...)`, a
    // derived expression whose *base* is still an identifier worth resolving. Falling
    // straight to the raw-source-text fallback for that last shape would print the
    // whole filter expression as if it were argv[0] itself (`bd args.filter(...)`,
    // which is not a real bd verb and is not what this call actually spawns).
    const baseIdent =
      argsNode.type === 'Identifier'
        ? argsNode
        : argsNode.type === 'CallExpression' && argsNode.callee.type === 'MemberExpression' && argsNode.callee.object.type === 'Identifier'
          ? argsNode.callee.object
          : null;

    if (argsNode.type === 'ArrayExpression') {
      ({ argv, dynamic } = resolveArrayLiteral(source, argsNode));
    } else if (baseIdent) {
      const decl = findDeclarator(fnNode.body, baseIdent.name, baseIdent.start);
      if (decl && decl.init && decl.init.type === 'ArrayExpression') {
        ({ argv } = resolveArrayLiteral(source, decl.init));
        pushes = pushesFor(source, fnNode.body, baseIdent.name);
        dynamic = true;
        if (argsNode !== baseIdent) {
          note = `spawned with \`${source.slice(argsNode.start, argsNode.end)}\` — the array above, further filtered at the call site`;
        }
      } else {
        argv = [`<${baseIdent.name}>`];
        dynamic = true;
        note = `argv is the variable \`${baseIdent.name}\` — its declaration could not be resolved statically`;
      }
    } else {
      argv = [source.slice(argsNode.start, argsNode.end)];
      dynamic = true;
      note = 'argv is a computed expression, not a literal array or a resolvable variable — shown as its own source text above, which is not itself a bd verb';
    }

    const optsNode = node.arguments[2];
    sites.push({
      bdCall,
      line: node.loc.start.line,
      argv,
      dynamic,
      pushes,
      note,
      retries: retriesOf(optsNode, constMap),
      optsRaw: optsNode ? source.slice(optsNode.start, optsNode.end) : null,
    });
  });
  return sites;
}

/** The `ClassDeclaration` named `className`, whether it sits bare in the module or
 * behind `export class ... {}` — `lib/bd.js` uses the latter. */
function findClass(programBody, className) {
  for (const stmt of programBody) {
    if (stmt.type === 'ClassDeclaration' && stmt.id?.name === className) return stmt;
    if (
      stmt.type === 'ExportNamedDeclaration' &&
      stmt.declaration?.type === 'ClassDeclaration' &&
      stmt.declaration.id?.name === className
    ) {
      return stmt.declaration;
    }
  }
  return null;
}

/**
 * Every method on `Bd`, as `lib/already.js`'s `moduleSurface` already describes it
 * (name, signature, doc, line — the exact surface `b7e-already` searches) plus, joined
 * in by name, the `bd` call sites this file adds: what each one actually spawns.
 */
export function bdMethods(root, { file = BD_SOURCE_REL, className = BD_CLASS_NAME } = {}) {
  const abs = path.join(root, file);
  const source = fs.readFileSync(abs, 'utf8');
  const surface = moduleSurface(root, file).filter((e) => e.kind === 'method' && e.ownerClass === className);

  let ast;
  try {
    ast = parseSource(source);
  } catch {
    return surface.map((entry) => ({ ...entry, shortName: entry.name.replace(`${className}.`, ''), calls: [] }));
  }
  const constMap = numericConsts(ast.body);
  const classDecl = findClass(ast.body, className);
  const members = classDecl ? classDecl.body.body.filter((m) => m.type === 'MethodDefinition') : [];
  const byName = new Map(members.map((m) => [m.key.type === 'Identifier' ? m.key.name : null, m]));

  return surface.map((entry) => {
    const shortName = entry.name.replace(`${className}.`, '');
    const member = byName.get(shortName);
    const calls = member && member.value.body ? callSitesIn(source, member.value, constMap) : [];
    return { ...entry, shortName, calls };
  });
}

/** Split an intent into the words it is scored against — `"close force"` → `['close',
 * 'force']`, `"reparent"` → `['reparent']`. */
export function tokenize(phrase) {
  return String(phrase || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Which of `methods` answer `queryWords`, best first — `scoreEntry` from
 * `lib/already.js`, unmodified: a query word must appear as a substring of the method's
 * name or the first line of its doc comment. See the file header for why that first-
 * line rule is load-bearing rather than incidental.
 */
export function searchMethods(methods, queryWords) {
  return methods
    .map((method) => ({ method, score: scoreEntry(method, queryWords) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.method.line - b.method.line)
    .map((s) => s.method);
}

/* --------------------------------------------------------- the installed bd itself */

function defaultExec(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

/**
 * A query word, anchored to a *left* word boundary and nothing on the right —
 * `\blease` matches "lease" and "leases" (a real hit) but not the "lease" sitting
 * inside "re**lease**" (the 'l' there follows another word character, so `\b` refuses
 * it) — while still matching "reparent**s**" for the query "reparent", which a
 * two-sided `\bword\b` would not. Raw `--help` text is prose, not identifier names, and
 * plain substring matching over it turns "lease" into a false hit on every "release"
 * `bd`'s own changelog prose mentions; a two-sided boundary would just as wrongly turn
 * "reparent" into a miss against the "reparents" that is the whole reason the flag
 * matches at all.
 */
function leftBoundary(word) {
  const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}`, 'i');
}

// A subcommand line in cobra's own `--help` layout: two-space indent, a bare lowercase
// name (never a flag — those start with `-`), two more spaces, then the description.
// Matches every section beadcause's installed `bd` prints (`Working With Issues:`,
// `Views & Reports:`, …) without needing to name any of them, and never matches a
// `Flags:`/`Global Flags:` line because those start with `-` or with extra indent.
const SUBCOMMAND_RE = /^ {2}([a-z][a-z0-9-]*) {2,}(.+)$/;

/** Every top-level `bd` subcommand named in `helpText` (the output of `bd --help`),
 * name and one-line summary, in the order `bd` printed them. */
export function bdTopLevelCommands(helpText) {
  const out = [];
  const seen = new Set();
  for (const raw of String(helpText || '').split('\n')) {
    const m = SUBCOMMAND_RE.exec(raw);
    if (!m) continue;
    const [, name, summary] = m;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, summary: summary.trim() });
  }
  return out;
}

/**
 * Every top-level `bd` command whose *full* `--help` text — not just its one-line
 * summary — mentions one of `queryWords`, best first. One extra spawn per command
 * (~50 of them, well under two seconds total): the summary alone answers "label" but
 * not "reparent", whose only real match is a flag's own description one level down.
 * `exec` is injectable so a suite can pin this against a fake `bd`.
 */
export function matchRawCommands(bdBin, queryWords, { exec = defaultExec, limit = 6 } = {}) {
  const words = (queryWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  if (!words.length) return [];
  let topText;
  try {
    topText = exec(bdBin, ['--help']);
  } catch {
    return [];
  }
  const commands = bdTopLevelCommands(topText);
  const scored = [];
  for (const cmd of commands) {
    let helpText;
    try {
      helpText = exec(bdBin, [cmd.name, '--help']);
    } catch {
      helpText = cmd.summary;
    }
    let score = 0;
    const matchedLines = [];
    for (const w of words) {
      const re = leftBoundary(w);
      // A word naming the command itself, or its own one-line summary, is a far
      // stronger signal than the same word turning up somewhere in fifty lines of
      // flag text — `label` (the command) and `reclaim`'s summary ("stale-**lease**")
      // would otherwise tie with every command whose help text merely mentions the
      // word once in passing, and lose on the alphabet.
      if (re.test(cmd.name)) score += 4;
      else if (re.test(cmd.summary)) score += 2;
      else if (re.test(helpText)) score += 1;
      else continue;
      const line = helpText.split('\n').find((l) => re.test(l));
      if (line && !matchedLines.includes(line.trim())) matchedLines.push(line.trim());
    }
    if (score > 0) scored.push({ name: cmd.name, summary: cmd.summary, score, matchedLines, helpText });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * The real `--help` text for the exact subcommand path a method's argv names —
 * `['label', 'add', ...]` fetches `bd label add --help` (the leaf's own flags), while
 * `['update', ...]` fetches `bd update --help` directly, because `update`'s second argv
 * element is an id, not a subverb. Decided generically, by asking `bd <verb> --help`
 * whether it lists `argv[1]` as one of its own `Available Commands:` — never by a
 * hand-kept list of which verbs happen to nest (`label`, `dep`, …).
 */
export function helpForArgv(bdBin, argv, { exec = defaultExec } = {}) {
  const verb = (argv || [])[0];
  if (!verb || verb.startsWith('<') || verb.startsWith('.')) return null;
  let text;
  try {
    text = exec(bdBin, [verb, '--help']);
  } catch {
    return null;
  }
  const second = argv[1];
  if (second && !second.startsWith('<') && /Available Commands:/.test(text)) {
    const subs = bdTopLevelCommands(text).map((c) => c.name);
    if (subs.includes(second)) {
      try {
        text = exec(bdBin, [verb, second, '--help']);
      } catch {
        /* keep the top-level text — the leaf refused, the parent still answers */
      }
    }
  }
  return text;
}

/** Every `--flag` a method's argv passes, checked against whether `helpText` (from
 * `helpForArgv`) actually advertises it — so an installed `bd` that dropped a flag a
 * wrapper still passes shows up as a line of output here, not as a failed call later. */
export function checkFlagsSupported(argv, helpText) {
  if (!helpText) return [];
  const out = [];
  const seen = new Set();
  for (const tok of argv || []) {
    const m = /^--([a-zA-Z0-9-]+)/.exec(tok);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ flag: m[1], supported: helpText.includes(`--${m[1]}`) });
  }
  return out;
}

/* ---------------------------------------------------------------- the memory notes */

/**
 * Every `beadcause-memory note` whose key or text mentions one of `queryWords`, best
 * first — a key match (`two-lease-concepts-native-bd-vs-held-label` naming "lease")
 * outranks a text-only one, because a key that names the topic is somebody already
 * having filed this under the word a reader would search for. `all` is `{key: value}`,
 * exactly what `lib/memory.js`'s `notes(agent)` returns — passed in rather than read
 * here so a suite can pin this against a canned store instead of the live one.
 */
export function matchNotes(all, queryWords, { limit = 5 } = {}) {
  const words = (queryWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const [key, value] of Object.entries(all || {})) {
    const text = String(value ?? '');
    let score = 0;
    for (const w of words) {
      const re = leftBoundary(w);
      if (re.test(key)) score += 2;
      else if (re.test(text)) score += 1;
    }
    if (score > 0) scored.push({ key, value: text, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit);
}
