#!/usr/bin/env node
//
// b7e-def — where a symbol is defined, in one call instead of four failed greps
// (bc-khoe.27.5).
//
//   npm test
//   node test/b7edef.mjs
//
// Runs the real command against this repo's own source, which is the whole point:
// the acceptance criteria on the bead are stated in terms of two real symbols
// (`indexFrom` in lib/ancestry.js, `loadBead` in lib/verdict.js) rather than a
// fixture, because a fixture cannot reproduce "lib/server.js is 10,560 lines" and
// that was the actual failure mode. If either symbol below ever moves, this test
// is meant to go red — a b7e-def that stops finding real code is worse than one
// that never shipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-def');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });

/**
 * `definitionsFor`, lifted out of the command and run in a `node:vm`.
 *
 * b7e-def is an extensionless bin with no exports and a top-level run section, so
 * it cannot be imported — and the whole-tree check below needs the function three
 * thousand times, which is three thousand process spawns as a CLI. This slices the
 * contiguous region that holds the blanking pass, the brace walk and
 * `definitionsFor` (plus the one-line `escapeRe` it borrows from above), evaluates
 * it, and hands back the function. It is a region slice rather than the
 * per-declaration brace-matching lift test/p0bead.mjs uses on public/app.js, so a
 * destructured parameter cannot truncate it; if the section markers ever move the
 * slice stops parsing or the function comes back undefined, and this suite goes red
 * naming it rather than quietly checking nothing.
 *
 * `acornArg` is what the vm sees as `acorn`. Passing `null` is how the
 * "devDependency is not installed" path gets exercised, since that is exactly what
 * the command's own optional import leaves behind.
 */
const liftDefinitionsFor = (src, acornArg = acorn) => {
  const startAt = src.search(/\/\*[- ]*blanking, off a real parse[- ]*\*\//);
  const endAt = src.indexOf('/* ---', src.indexOf('function definitionsFor'));
  const escapeReLine = src.match(/^const escapeRe = .*$/m);
  assert.ok(startAt >= 0, "bin/b7e-def has no 'blanking, off a real parse' section marker to slice from");
  assert.ok(endAt > startAt, 'bin/b7e-def has no section marker after definitionsFor to slice to');
  assert.ok(escapeReLine, 'bin/b7e-def no longer defines escapeRe on one line');
  const chunk = `${escapeReLine[0]}\n${src.slice(startAt, endAt)}\ndefinitionsFor;`;
  const fn = vm.runInNewContext(chunk, { acorn: acornArg });
  assert.equal(typeof fn, 'function', 'the lifted slice did not end with definitionsFor');
  return fn;
};

const SOURCE = fs.readFileSync(BIN, 'utf8');

/** Every top-level `function f` / `export function f` acorn finds in `text`. */
const topLevelFunctions = (text) => {
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true, locations: true });
  } catch {
    return null; // blankForBraceWalk falls back to the raw text for these, by design
  }
  const out = [];
  for (const node of ast.body) {
    const fn =
      node.type === 'FunctionDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration'
          ? node.declaration
          : null;
    if (fn?.id) out.push(fn);
  }
  return out;
};

const sourceFiles = () => {
  const skip = new Set(['node_modules', '.git', 'vendor', 'coverage']);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(full);
    }
  };
  for (const d of ['lib', 'bin', 'public', 'scripts', 'test']) walk(path.join(ROOT, d));
  return out;
};

console.log('\nfinding a real definition, in one call');

{
  const r = run(['indexFrom']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('names lib/ancestry.js, not just the file that imports it', /^lib\/ancestry\.js:\d+-\d+/m.test(r.stdout), r.stdout);
  check('includes the doc comment above the function', r.stdout.includes('giving back every half of what the export is worth reading for'), r.stdout);
  check('includes the function body, not just its head', r.stdout.includes('return { parents, beads, adopts, edges };'), r.stdout);
}

console.log('\na name only imported where you look is not the answer — the real site is');

{
  // loadBead is imported into lib/server.js and lib/discuss.js; defined in
  // lib/verdict.js. The acceptance criterion is specifically that b7e-def finds
  // the real site rather than stopping at an import.
  const r = run(['loadBead']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('reports the import into lib/server.js', /imported at lib\/server\.js:\d+ \(from '\.\/verdict\.js'\)/.test(r.stdout), r.stdout);
  check('reports the real definition in lib/verdict.js', /^lib\/verdict\.js:\d+-\d+/m.test(r.stdout), r.stdout);
  check('the real definition is printed, not just named', r.stdout.includes('export async function loadBead('), r.stdout);
}

console.log('\ntwo definitions is a report of two, not a guess');

{
  // `normalize` is a plain (non-exported) function, independently defined in at
  // least three files here — not one function imported under the same name.
  const r = run(['normalize']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  const spans = [...r.stdout.matchAll(/^lib\/[\w./-]+:\d+-\d+/gm)];
  check('finds at least two independent definitions', spans.length >= 2, `found ${spans.length}:\n${r.stdout}`);
  const files = new Set(spans.map((m) => m[0].split(':')[0]));
  check('they are in different files, not one match repeated', files.size >= 2, [...files].join(', '));
}

console.log('\na name with no definition exits non-zero and says so');

{
  const r = run(['thisSymbolDoesNotExistAnywhereInThisRepoXyz']);
  check('exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says so, rather than printing nothing', /no definition of/.test(r.stdout), r.stdout);
}

console.log('\n--callers adds call sites without duplicating the definition or the import');

{
  const r = run(['pairKey', '--callers']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('lists at least one caller', /^callers \(\d+\):/m.test(r.stdout), r.stdout);
  check('a known call site is named', /lib\/adoptsweep\.js:\d+:.*pairKey\(/.test(r.stdout), r.stdout);
  const defLine = r.stdout.match(/^lib\/ancestry\.js:(\d+)-\d+/m);
  check('the definition line itself is not re-listed as a caller', Boolean(defLine) && !new RegExp(`callers[\\s\\S]*lib/ancestry\\.js:${defLine?.[1]}:`).test(r.stdout), r.stdout);
}

console.log('\na call passing an object literal is not mistaken for a definition (bc-dgx7.36)');

{
  // openReviewAnswerSession is a real export in lib/session.js. Its only call site,
  // lib/server.js:3322, is a bare `openReviewAnswerSession(...)` at the start of a
  // trimmed line — syntactically identical to the method/property-function head
  // shape — whose own closing `)` is immediately followed by a comma, then
  // `resolveFor`'s own third-argument object literal three arguments later. Before
  // bc-dgx7.36, findBody walked past that comma to the first `{` at depth 0,
  // however far away, and reported the call site as a second, phantom definition.
  const r = run(['openReviewAnswerSession']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  const spans = [...r.stdout.matchAll(/^lib\/[\w./-]+:\d+-\d+/gm)];
  check('exactly one definition, not the call site too', spans.length === 1, `found ${spans.length}:\n${r.stdout}`);
  check('the one definition is in lib/session.js', spans[0]?.[0].startsWith('lib/session.js:'), r.stdout);
  check('no phantom definition at the lib/server.js call site', !spans.some((m) => m[0].startsWith('lib/server.js:')), r.stdout);
}

console.log('\nno name, or --help, is a usage message rather than a crash');

{
  const r = run([]);
  check('bare invocation exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('prints usage', /b7e-def <name>/.test(r.stderr), r.stderr);
}

{
  const r = run(['--help']);
  check('--help exits 0', r.status === 0, `status was ${r.status}`);
  check('prints usage', /b7e-def <name>/.test(r.stdout), r.stdout);
}

console.log('\na regex or a nested template in the body does not run the span past the end (bc-3rjan)');

{
  // The bead's own reproduction: normalizeEntry's second line holds /^["']|["']$/, whose
  // " was read by skipString as a string opener — the string then "closed" at some later
  // unrelated quote and matchBrace ran the end from 136 out to 525, the length of the file.
  // Pinned against acorn's own loc rather than against the literal numbers, so the function
  // moving down the file does not make this red for the wrong reason.
  const text = fs.readFileSync(path.join(ROOT, 'lib/beadfiles.js'), 'utf8');
  const fn = topLevelFunctions(text)?.find((f) => f.id.name === 'normalizeEntry');
  check('lib/beadfiles.js still defines normalizeEntry', Boolean(fn), 'the reproduction moved — pick another regex-bodied function');
  if (fn) {
    const body = text.split('\n').slice(fn.loc.start.line - 1, fn.loc.end.line).join('\n');
    check(
      "its body still holds the regex with a quote in it, so this is still testing the bug",
      /\/\^\["']/.test(body),
      'the regex literal left normalizeEntry — this check has stopped exercising the desync',
    );
    const r = run(['normalizeEntry']);
    check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
    check(
      `reports lib/beadfiles.js:${fn.loc.start.line}-${fn.loc.end.line}, the extent acorn gives it`,
      r.stdout.includes(`lib/beadfiles.js:${fn.loc.start.line}-${fn.loc.end.line}`),
      r.stdout.split('\n')[0],
    );
  }
}

console.log('\nevery top-level function in this repo gets the extent acorn gives it');

{
  // The whole-tree pin, and the check to run against ANY future port of this walk: a
  // hand-rolled scanner and a real parser must agree about where a function ends. Measured
  // on this tree with the walk reading the raw text, as it did before bc-3rjan: 82 of 3118
  // disagreed, normalizeEntry among them.
  const definitionsFor = liftDefinitionsFor(SOURCE);
  const wrong = [];
  let checked = 0;
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    const fns = topLevelFunctions(text);
    if (!fns) continue;
    const rel = path.relative(ROOT, f);
    for (const fn of fns) {
      checked += 1;
      const def = definitionsFor(fn.id.name, rel, text).find((d) => d.startLine === fn.loc.start.line);
      if (!def) wrong.push(`${rel}:${fn.loc.start.line} ${fn.id.name} not found at all`);
      else if (def.endLine !== fn.loc.end.line) {
        wrong.push(`${rel}:${fn.loc.start.line} ${fn.id.name} endLine ${def.endLine} vs acorn ${fn.loc.end.line}`);
      }
    }
  }
  check('the whole tree was walked, not a corner of it', checked > 2000, `only checked ${checked}`);
  check(`all ${checked} agree with acorn`, wrong.length === 0, `${wrong.length} disagree:\n      ${wrong.slice(0, 10).join('\n      ')}`);
}

console.log('\nwithout acorn, and on a file acorn cannot parse, it falls back rather than throwing');

{
  // acorn is a devDependency and this command is on the default tool list, so it has to keep
  // working from a worktree with no node_modules — the blanking pass hands back the raw text
  // and the walk is exactly as good (and as wrong) as it was before bc-3rjan. Same path for
  // a file that will not parse at all.
  const withoutAcorn = liftDefinitionsFor(SOURCE, null);
  const simple = 'function plain(a) {\n  return a;\n}\n';
  const defs = withoutAcorn('plain', 'x.js', simple);
  check('with no acorn at all, a plain function is still found', defs.length === 1 && defs[0].endLine === 3, JSON.stringify(defs));

  const definitionsFor = liftDefinitionsFor(SOURCE);
  const unparseable = 'function plain(a) {\n  return a;\n}\nthis ( is not ) javascript ===\n';
  const onGarbage = definitionsFor('plain', 'x.js', unparseable);
  check('a file acorn cannot parse is scanned raw rather than skipped', onGarbage.length === 1 && onGarbage[0].endLine === 3, JSON.stringify(onGarbage));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
