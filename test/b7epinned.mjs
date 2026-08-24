#!/usr/bin/env node
//
// b7e-pinned — which test/*.mjs assertions are pinned to the exact words of a module's
// generated prose (bc-khoe.27.12).
//
//   npm test
//   node test/b7epinned.mjs
//
// The tokenizer and holder-derivation primitives are proved directly, against small
// hand-written snippets — the same argument test/b7eowes.mjs makes for its own pure
// extractors. `pinnedIn` and the CLI are then proved against a FABRICATED fixture root
// (a throwaway `lib/` + `test/` pair written to a tmp dir), never against this repo's
// own suites for anything beyond a loose sanity check — a real-repo assertion pins
// ANOTHER module's wording, which drifts under this suite without this branch changing
// (see the memory note a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci).
// The one exception is the two headline examples bc-khoe.27.12 itself was filed over —
// test/onelaw.mjs's `/this bead stays open/i` and test/land.mjs's `/four honest
// endings/` — checked by pattern, not by line number, because those two are the bead's
// own definition of "found it" rather than incidental facts about another module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-pinned');

const pinned = await import(path.join(ROOT, 'lib', 'pinned.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ================================================================ 1. literalsIn / splitArgs */

console.log('\nliteralsIn and splitArgs — the tokenizer\n');

check('literalsIn finds a string and a regex, left to right, with real offsets', () => {
  const text = "assert.match(x, /foo\\s+bar/i); x.includes('baz');";
  const lits = pinned.literalsIn(text);
  assert.equal(lits.length, 2);
  assert.equal(lits[0].kind, 'regex');
  assert.equal(lits[0].content, 'foo\\s+bar');
  assert.equal(lits[0].flags, 'i');
  assert.equal(text.slice(lits[0].index, lits[0].index + lits[0].raw.length), '/foo\\s+bar/i');
  assert.equal(lits[1].kind, 'string');
  assert.equal(lits[1].content, 'baz');
});

check('a `/` that divides is not read as a regex', () => {
  const lits = pinned.literalsIn('const half = total / 2 / width;');
  assert.equal(lits.length, 0);
});

check('a comma inside a regex character class does not split an argument', () => {
  const text = "assert.match(x, /[a,b]+/);";
  const openIndex = text.indexOf('(', text.indexOf('assert.match'));
  const { args } = pinned.splitArgs(text, openIndex);
  assert.equal(args.length, 2);
  assert.equal(args[1].text.trim(), '/[a,b]+/');
});

check('a nested call in an argument does not split early', () => {
  const text = "assert.equal(f(a, b), 'x');";
  const openIndex = text.indexOf('(', text.indexOf('assert.equal'));
  const { args } = pinned.splitArgs(text, openIndex);
  assert.equal(args.length, 2);
  assert.equal(args[0].text.trim(), 'f(a, b)');
  assert.equal(args[1].text.trim(), "'x'");
});

/* ================================================================ 2. moduleExports / deriveHolders */

console.log('\nmoduleExports and deriveHolders — which local names hold the output\n');

check('moduleExports reads function, const and let exports, not local helpers', () => {
  const src = `
    function local() {}
    export function promptFor() {}
    export const OTHER = 1;
    export let mutable = 2;
  `;
  const names = pinned.moduleExports(src);
  assert.deepEqual([...names].sort(), ['OTHER', 'mutable', 'promptFor']);
});

check('a one-hop local wrapper joins the holder set', () => {
  // `deriveHolders` reads whatever `statements()` + `mergeContinuations` hand it — an
  // arrow assignment split over two lines is one logical statement by the time it gets
  // here (see mergeContinuations's own docblock for why `statements()` alone splits it).
  const stmts = [{ text: 'const wrap = (x) =>\n  promptFor(x);', start: 0, end: 1 }];
  const holders = pinned.deriveHolders(stmts, new Set(['promptFor']));
  assert.ok(holders.has('wrap'));
});

check('a for-of destructure over an array of holders grows every bound name', () => {
  const stmts = [{ text: "for (const [name, brief] of [['a', land], ['b', ask]]) {", start: 0, end: 0 }];
  const holders = pinned.deriveHolders(stmts, new Set(['land', 'ask']));
  assert.ok(holders.has('brief'), 'the value position should be traced');
  assert.ok(holders.has('name'), 'both destructured names grow, even the label');
});

check('an unrelated local name does not join the set', () => {
  const stmts = [{ text: "const other = somethingElse();", start: 0, end: 0 }];
  const holders = pinned.deriveHolders(stmts, new Set(['promptFor']));
  assert.ok(!holders.has('other'));
});

/* ================================================================ 3. pinnedIn against a fixture */

console.log('\npinnedIn — against a fabricated lib/ + test/ pair\n');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-pinned-test-'));

function fixture(files) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const LIB_SRC = `
export function briefFor(name) {
  const lines = [];
  lines.push('welcome ' + name);
  lines.push('this bead stays open until it is answered');
  lines.push('the merge queue handles it');
  return lines.join('\\n');
}
export function other() {
  return 'unrelated to prose';
}
`;

const TEST_SRC = `
import assert from 'node:assert';
const { briefFor } = await import(LIB('pinned-fixture.js'));
const wrap = (n) => briefFor(n);
const brief = wrap('adam');
assert.match(brief, /this bead stays open/i);
assert.match(brief, /four honest endings/);
assert.ok(brief.includes('the merge queue handles it'));
assert.match(brief, /no path here by which\\nagent endorses/, 'a hard newline inside the pattern');
assert.equal(brief.length, 3, 'three lines pushed');
`;

const root = fixture({
  'lib/pinned-fixture.js': LIB_SRC,
  'test/fixture.mjs': TEST_SRC,
});

const modSrc = fs.readFileSync(path.join(root, 'lib', 'pinned-fixture.js'), 'utf8');
const suites = pinned.pinnedIn(root, 'pinned-fixture.js', modSrc);

check('the suite that imports the module is found, and one that does not is not', () => {
  assert.equal(suites.length, 1);
  assert.equal(suites[0].file, 'fixture.mjs');
});

check('a literal that survives, through a one-hop wrapper, is flagged inSource', () => {
  const f = suites[0].findings.find((x) => x.raw === '/this bead stays open/i');
  assert.ok(f);
  assert.equal(f.inSource, true);
  assert.equal(f.hasNewline, false);
  assert.equal(f.hasNumber, false);
});

check('a literal with no match in the source today is flagged NOT in source', () => {
  const f = suites[0].findings.find((x) => x.raw === '/four honest endings/');
  assert.ok(f);
  assert.equal(f.inSource, false);
  assert.equal(f.hasNumber, true, 'spelled-out counts count as numbers too');
});

check('a literal nested in assert.ok(...includes(...)) is found once, not twice', () => {
  const hits = suites[0].findings.filter((x) => x.raw === "'the merge queue handles it'");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].inSource, true);
});

check('a pattern with a literal newline escape is flagged HAS-NEWLINE', () => {
  const f = suites[0].findings.find((x) => x.kind === 'regex' && x.raw.includes('\\n'));
  assert.ok(f, 'the \\n-carrying pattern should have been found');
  assert.equal(f.hasNewline, true);
});

check('a message argument is never reported as a pinned literal', () => {
  const hits = suites[0].findings.filter((x) => x.raw.includes('three lines pushed') || x.raw.includes('a hard newline inside'));
  assert.equal(hits.length, 0);
});

check('a module nothing imports yields no suites at all', () => {
  const emptyRoot = fixture({
    'lib/nobody-reads-this.js': 'export function x() { return "y"; }\n',
    'test/unrelated.mjs': "import assert from 'node:assert';\nassert.ok(true);\n",
  });
  const src = fs.readFileSync(path.join(emptyRoot, 'lib', 'nobody-reads-this.js'), 'utf8');
  const result = pinned.pinnedIn(emptyRoot, 'nobody-reads-this.js', src);
  assert.deepEqual(result, []);
});

check('a `builder` name narrows the seed to just that export', () => {
  const narrowSrc = `
    export function promptA() { return 'a says hello'; }
    export function promptB() { return 'b says hello'; }
  `;
  const narrowTest = `
    const { promptA, promptB } = await import(LIB('narrow.js'));
    const a = promptA();
    const b = promptB();
    check(/a says hello/.test(a));
    check(/b says hello/.test(b));
  `;
  const narrowRoot = fixture({ 'lib/narrow.js': narrowSrc, 'test/narrow.mjs': narrowTest });
  const src = fs.readFileSync(path.join(narrowRoot, 'lib', 'narrow.js'), 'utf8');
  const wide = pinned.pinnedIn(narrowRoot, 'narrow.js', src);
  const scoped = pinned.pinnedIn(narrowRoot, 'narrow.js', src, { builder: 'promptA' });
  assert.equal(wide[0].findings.length, 2, 'both prompts show up unscoped');
  assert.equal(scoped[0].findings.length, 1, 'only promptA\'s literal shows up scoped');
  assert.equal(scoped[0].findings[0].raw, '/a says hello/');
});

/* ================================================================ 4. the CLI */

console.log('\nbin/b7e-pinned — argv, exit codes, --json\n');

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-pinned/);
});

check('a module nobody asserts prose on prints nothing and exits 0', () => {
  const emptyRoot = fixture({
    'lib/quiet.js': 'export function x() { return "y"; }\n',
    'test/unrelated.mjs': "import assert from 'node:assert';\nassert.ok(true);\n",
  });
  const r = spawnSync(process.execPath, [BIN, '--dir', emptyRoot, 'lib/quiet.js'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
});

check('a module that resolves to nothing exits 2', () => {
  const r = spawnSync(process.execPath, [BIN, '--dir', root, 'lib/does-not-exist.js'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not resolve/);
});

check('the fixture module prints its findings, flags and all', () => {
  const r = spawnSync(process.execPath, [BIN, '--dir', root, 'lib/pinned-fixture.js'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /fixture\.mjs/);
  assert.match(r.stdout, /this bead stays open/i);
  assert.match(r.stdout, /NOT IN SOURCE/);
  assert.match(r.stdout, /HAS-NEWLINE/);
});

check('--json prints one parseable object grouped by suite', () => {
  const r = spawnSync(process.execPath, [BIN, '--dir', root, 'lib/pinned-fixture.js', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.module, 'lib/pinned-fixture.js');
  assert.equal(obj.suites.length, 1);
  assert.equal(obj.suites[0].file, 'fixture.mjs');
});

check('a bare basename resolves under lib/ without the full path', () => {
  const r = spawnSync(process.execPath, [BIN, '--dir', root, 'pinned-fixture.js'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pinned-fixture\.js/);
});

/* ================================================================ 5. the real repo's own two founding examples */

console.log("\nthe bead's own two founding examples, still true on this repo today\n");

check('lib/session.js: test/onelaw.mjs still pins /this bead stays open/i', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');
  const found = pinned.pinnedIn(ROOT, 'session.js', src);
  const suite = found.find((s) => s.file === 'onelaw.mjs');
  assert.ok(suite, 'test/onelaw.mjs should be read as a suite pinned to session.js');
  assert.ok(
    suite.findings.some((f) => /this bead stays open/i.test(f.raw)),
    'the exact guard bc-bmry.8 shipped a red over should still be found',
  );
});

check('lib/session.js: test/land.mjs still pins /four honest endings/, flagged as carrying a number', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');
  const found = pinned.pinnedIn(ROOT, 'session.js', src);
  const suite = found.find((s) => s.file === 'land.mjs');
  assert.ok(suite, 'test/land.mjs should be read as a suite pinned to session.js');
  const f = suite.findings.find((x) => /four honest endings/.test(x.raw));
  assert.ok(f, 'the count bc-bmry.7 baked into a regex should still be found');
  assert.equal(f.hasNumber, true, 'a spelled-out count is still a count');
});

/* ------------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} failing\n`);
  process.exit(1);
} else {
  console.log('\nall checks passed\n');
}
