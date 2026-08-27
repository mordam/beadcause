#!/usr/bin/env node
//
// The registries a `b7e-*` tool used to have to edit are derived from the tool itself,
// and every way that derivation can rot.
//
//   npm test
//   node test/tooldecl.mjs
//
// bc-wbrhi. Adding one tool used to mean a line in `lib/grants.js`, seven in
// `lib/toolbelt.js`, one in `package.json` and one mirrored in `package-lock.json`, on top
// of the three files that were actually new — and every one of those lines went in at the
// same place in its file. On 2026-08-26, ten of the fourteen open pull requests touching
// `lib/grants.js` were inserting at line 333, so one of them landing conflicted the other
// nine by construction. bc-8479e made those conflicts resolve themselves; this makes them
// not happen, by moving the fact into the file it is a fact about.
//
// ## Why this suite exists rather than trusting the derivation
//
// Because a derivation fails quietly. A literal that is missing is a line somebody can see
// is missing; a scan that stops matching produces a shorter list and no error at all, and
// the far end of that is an agent that has silently lost a capability — or, if the
// direction ever inverted, gained one. So this asks the question three ways:
//
// 1. **The live repo agrees with itself.** `DECLARATION_PROBLEMS` is empty, every granted
//    declaration is classified in `GRANTS`, and no name is both declared and hand-written.
// 2. **The scan still bites.** Each rule is driven against a made-up `bin/` — a file with
//    two declarations, one with a kind nobody has heard of, a directory that is not there.
//    "It found no problems" is equally true of a function that can no longer find any.
// 3. **The bin map and `bin/` agree**, which is the acceptance criterion this bead was
//    filed with and the one thing `npm` needs written out literally.
//
// ## What is deliberately not asserted
//
// **That every file in `bin/` has a map entry.** `bin/router.js` and `bin/status.js` are
// spawned by path and are not npm entry points, and nothing intrinsic separates them from
// `bin/ask.js`, which is one: the exec bit does not (five in-map files lack it and so do
// both of those), and all of them carry a shebang. So the check is scoped to the `b7e-*`
// family, which is the family this bead is about and the one where a missing entry means a
// command an agent is told to run and cannot.
//
// **That `b7e-owes` and `b7e-say` point at extensionless files.** They point at `.js` ones,
// which `bin/b7e-enroll`'s own header calls an existing mismatch that bc-jlop and bc-dgx7.2
// own. The check asks that the map entry points at a file that *exists*, not that the file
// is named a particular way — a suite that "fixed" that here would be taking a decision two
// other beads are holding.
//
// **That `b7e-packet` and `b7e-say` are decided.** Neither declares anything, because
// nobody has decided about them; `b7e-enroll` reported both as unpaid before this change
// and reports both after it. Asserting them undeclared would be pinning today's backlog as
// though it were the design, so this asserts the consequence instead: an undeclared tool is
// not granted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const { DECLARATIONS, DECLARATION_PROBLEMS, B7E_GRANTS, EXCLUDED, DEFAULT_TOOL_LIST, KINDS, declarationsIn, readDeclarations, commandName } =
  await import(LIB('tooldecl.js'));
const { BASE_TOOL_LIST } = await import(LIB('toolbelt.js'));
const { GRANTS } = await import(LIB('grants.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

/** A throwaway `bin/` with the files a case needs. Removed on exit, like every other suite. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tooldecl-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function fakeBin(files) {
  const dir = path.join(scratch, `bin${(n += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const tool = (kind) => `#!/usr/bin/env node\n/**\n * Does a thing.\n *\n * @grant ${kind}\n */\n`;

console.log('\nthe b7e registries, derived from the tools\n');

/* ------------------------------------------------------------------ 1. the live repo */

check('every declaration in bin/ is one this understands', () => {
  assert.deepEqual([...DECLARATION_PROBLEMS], [], DECLARATION_PROBLEMS.join('\n'));
});

check('and it was read against the real bin/, not an empty one', () => {
  // The failure mode this whole suite is about: a scan that quietly matches nothing
  // reports no problems and produces no grants, and both halves look like success.
  assert.ok(DECLARATIONS.length >= 60, `only ${DECLARATIONS.length} declarations — the scan is not reading bin/`);
  assert.ok(Object.keys(B7E_GRANTS).length >= 30, `only ${Object.keys(B7E_GRANTS).length} granted`);
  assert.ok(EXCLUDED.length >= 20, `only ${EXCLUDED.length} excluded`);
});

check('the list is the hand-written half plus the granted half, and nothing twice', () => {
  assert.deepEqual(DEFAULT_TOOL_LIST, [...BASE_TOOL_LIST, ...Object.keys(B7E_GRANTS)]);
  assert.equal(new Set(DEFAULT_TOOL_LIST).size, DEFAULT_TOOL_LIST.length, 'an entry appears twice');
});

check('every granted tool is classified in GRANTS, with the kind it declared', () => {
  // Check 7 of bin/b7e-enroll, asserted here rather than only reported there: an entry on
  // DEFAULT_TOOL_LIST that lib/grants.js cannot classify is what test/grants.mjs fails on,
  // and the wiring that makes that impossible is worth pinning rather than assuming.
  for (const [pattern, grant] of Object.entries(B7E_GRANTS)) {
    assert.ok(GRANTS[pattern], `${pattern} is granted and unclassified`);
    assert.equal(GRANTS[pattern].kind, grant.kind, `${pattern} is classified ${GRANTS[pattern].kind}, declared ${grant.kind}`);
  }
});

check('and no name is both declared in bin/ and written out in lib/grants.js', () => {
  // There is deliberately no precedence rule — see the comment beside the spread in
  // lib/grants.js. A collision is a mistake, and this is where it is caught rather than
  // resolved in whichever direction the spread happens to sit.
  const src = fs.readFileSync(LIB('grants.js'), 'utf8');
  const written = [...src.matchAll(/^\s*'(Bash\(b7e-[a-z0-9-]+:\*\))'\s*:/gm)].map((m) => m[1]);
  assert.deepEqual(written, [], `written out by hand as well as declared: ${written.join(', ')}`);
});

check('an excluded tool is a decision, not a grant', () => {
  for (const name of EXCLUDED) {
    assert.ok(!B7E_GRANTS[`Bash(${name}:*)`], `${name} declares itself excluded and is granted anyway`);
    assert.ok(!DEFAULT_TOOL_LIST.includes(`Bash(${name}:*)`), `${name} is excluded and on the list`);
  }
});

check('and a tool that declares nothing is not granted either', () => {
  // Deny by default, which is lib/grants.js's whole design applied one layer earlier: a
  // tool nobody has decided about is one `dispatch` cannot call, and it stays that way
  // until somebody writes the line.
  const declared = new Set(DECLARATIONS.map((d) => d.name));
  const undeclared = fs
    .readdirSync(path.join(ROOT, 'bin'))
    .filter((f) => /^b7e-/.test(f))
    .map(commandName)
    .filter((name) => !declared.has(name));
  for (const name of undeclared) assert.ok(!B7E_GRANTS[`Bash(${name}:*)`], `${name} declares nothing and is granted`);
});

/* --------------------------------------------------------- 2. the bin map and bin/ */

check('every b7e tool in bin/ has a package.json bin entry pointing at it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = fs
    .readdirSync(path.join(ROOT, 'bin'))
    .filter((f) => /^b7e-/.test(f))
    .filter((f) => pkg.bin[commandName(f)] !== `bin/${f}`);
  assert.deepEqual(missing, [], `in bin/ with no matching entry: ${missing.join(', ')}`);
});

check('and every b7e bin entry points at a file that is there', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dangling = Object.entries(pkg.bin)
    .filter(([name]) => name.startsWith('b7e-'))
    .filter(([, rel]) => !fs.existsSync(path.join(ROOT, rel)))
    .map(([name, rel]) => `${name} -> ${rel}`);
  assert.deepEqual(dangling, [], `entries pointing at nothing: ${dangling.join(', ')}`);
});

check('the two .js names are left exactly as they are', () => {
  // bc-jlop and bc-dgx7.2 own relitigating those; the checks above must pass over them
  // rather than through them, so this pins that they are still the shape that would trip
  // a stricter rule — if they are ever fixed, this check is the one to delete.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-owes'], 'bin/b7e-owes.js');
  assert.equal(pkg.bin['b7e-say'], 'bin/b7e-say.js');
});

/* ------------------------------------------------------- 3. every rule, proved to bite */

check('a declaration is found in both comment shapes', () => {
  assert.deepEqual(declarationsIn('/**\n * @grant read\n */'), ['read']);
  assert.deepEqual(declarationsIn('// @grant excluded'), ['excluded']);
  assert.deepEqual(declarationsIn('   *   @grant write   '), ['write']);
});

check('and @grant written mid-sentence is prose, not a declaration', () => {
  // The tools argue about each other constantly — lib/tooldecl.js is 582 lines of exactly
  // that — so a paragraph naming the marker must not read as one.
  assert.deepEqual(declarationsIn(' * say `@grant read` in the header, next to the reason'), []);
  assert.deepEqual(declarationsIn(' * The @grant read line is what decides it.'), []);
});

check('a file with no declaration says so by saying nothing', () => {
  assert.deepEqual(declarationsIn('#!/usr/bin/env node\n/** Does a thing. */\n'), []);
  assert.deepEqual(declarationsIn(''), []);
  assert.deepEqual(declarationsIn(null), []);
});

check('two declarations in one file is a problem, not a first-one-wins', () => {
  const dir = fakeBin({ 'b7e-two': `${tool('read')}\n// @grant excluded\n` });
  const { declared, problems } = readDeclarations(dir);
  assert.equal(declared.length, 0, 'it picked one of the two');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /declares @grant 2 times/);
});

check('a kind nobody has heard of is refused rather than treated as a grant', () => {
  const dir = fakeBin({ 'b7e-odd': tool('readonly') });
  const { declared, problems } = readDeclarations(dir);
  assert.equal(declared.length, 0);
  assert.match(problems[0], /@grant readonly, which is not one of read, write, excluded/);
  assert.deepEqual(KINDS, ['read', 'write', 'excluded']);
});

check('a bin/ that cannot be read produces no grants and one loud problem', () => {
  // The direction matters more than the message: a failed read must shrink the allowlist
  // toward the hand-written base, never leave it looking complete.
  const { declared, problems } = readDeclarations(path.join(scratch, 'not-a-directory'));
  assert.deepEqual(declared, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be read/);
});

check('only b7e-* files are read — the rest of bin/ declares nothing here', () => {
  const dir = fakeBin({ 'b7e-yes': tool('read'), 'router.js': '// @grant read\n', 'ask.js': tool('write') });
  const { declared, problems } = readDeclarations(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(declared.map((d) => d.name), ['b7e-yes']);
});

check('a .js file is read, and is named as the command it is run as', () => {
  const dir = fakeBin({ 'b7e-suffix.js': tool('read') });
  const { declared } = readDeclarations(dir);
  assert.deepEqual(declared, [{ name: 'b7e-suffix', file: 'b7e-suffix.js', kind: 'read' }]);
  assert.equal(commandName('b7e-suffix.js'), 'b7e-suffix');
  assert.equal(commandName('b7e-plain'), 'b7e-plain');
});

check('one command declared by two files is a problem', () => {
  // The shape the .js names make possible: `b7e-x` and `b7e-x.js` both present, each
  // declaring, and only one of them is what `package.json` actually runs.
  const dir = fakeBin({ 'b7e-dup': tool('read'), 'b7e-dup.js': tool('excluded') });
  const { problems } = readDeclarations(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b7e-dup is declared by more than one file/);
});

check('excluded produces a decision and no grant', () => {
  const dir = fakeBin({ 'b7e-off': tool('excluded'), 'b7e-on': tool('read') });
  const { declared, problems } = readDeclarations(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    declared.map((d) => [d.name, d.kind]),
    [
      ['b7e-off', 'excluded'],
      ['b7e-on', 'read'],
    ]
  );
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
