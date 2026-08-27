#!/usr/bin/env node
//
// b7e-which — which of these commands answers this question, the library has no index
// (bc-dgx7.65).
//
//   npm test
//   node test/b7ewhich.mjs
//
// Two halves. First, lib/which.js's pieces (docblock parsing, allowlist status, README
// anchor lookup, ranking) driven directly against a fabricated fixture tree — small,
// deterministic, and immune to the real bin/ growing or a docblock's prose being reworded
// out from under this suite. Second, the real command, spawned, against BOTH the fixture
// (the disk-derived-count and malformed-docblock guarantees) and this repo's own real
// bin/ (the two examples the bead's own acceptance criteria give verbatim — a real-repo
// assertion, per memory note a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci,
// so it is written as "ranks above" / "is named at all" rather than an exact score, which
// is the part of the answer this bead actually promises and the part unlikely to move
// under a docblock reword).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-which');

const { candidateNames, parseDocblock, allowlistStatus, readmeAnchorFor, fullIndex, queryTokens, scoreEntry, search } = await import(
  path.join(ROOT, 'lib', 'which.js')
);
const { analyze } = await import(path.join(ROOT, 'lib', 'readme.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nb7e-which\n');

/* ---------------------------------------------------------------- parseDocblock */

console.log('parseDocblock');

check('a name-prefixed single-line question is stripped of the prefix', () => {
  const src = "#!/usr/bin/env node\n/**\n * `b7e-gate` — the whole `npm test` suite, without bailing at the first red.\n *\n *     b7e-gate --jobs 4\n */\n";
  const { question, usage } = parseDocblock(src, 'b7e-gate');
  assert.equal(question, 'the whole `npm test` suite, without bailing at the first red.');
  assert.deepEqual(usage, ['b7e-gate --jobs 4']);
});

check('a question with no name prefix is taken as written', () => {
  const src = '/**\n * Where a symbol is defined, in one call instead of four failed greps.\n *\n *   b7e-def <name>\n */\n';
  const { question } = parseDocblock(src, 'b7e-def');
  assert.equal(question, 'Where a symbol is defined, in one call instead of four failed greps.');
});

check('a two-line opening paragraph is joined into one question, not cut at the first newline', () => {
  const src =
    '/**\n * `b7e-gates` — which gate runners are on this Mac, whose worktree each one is, and\n * ending only mine.\n *\n *     b7e-gates --mine\n */\n';
  const { question } = parseDocblock(src, 'b7e-gates');
  assert.equal(question, 'which gate runners are on this Mac, whose worktree each one is, and ending only mine.');
});

check('usage lines are collected wherever they occur, not just right after the question', () => {
  const src =
    '/**\n * `b7e-x` — does a thing.\n *\n * Some rationale paragraph that mentions b7e-x by name mid-sentence, which is not a\n * usage line because it does not start the (trimmed) line.\n *\n *   b7e-x --flag\n */\n';
  const { usage } = parseDocblock(src, 'b7e-x');
  assert.deepEqual(usage, ['b7e-x --flag']);
});

check('a file with no docblock at all reports a null question and no usage', () => {
  const src = "#!/usr/bin/env node\nconsole.log('hi');\n";
  const { question, usage, raw } = parseDocblock(src, 'b7e-nodoc');
  assert.equal(question, null);
  assert.deepEqual(usage, []);
  assert.equal(raw, '');
});

check('an empty docblock (whitespace/asterisks only) also reports a null question', () => {
  const src = '/**\n *\n *\n */\n';
  const { question } = parseDocblock(src, 'b7e-blank');
  assert.equal(question, null);
});

/* ---------------------------------------------------------------- allowlistStatus */

console.log('\nallowlistStatus');

/*
 * Since bc-wbrhi the answer is the tool's own `@grant` line rather than a reading of
 * lib/toolbelt.js's source text, so the fixture is a tool rather than a registry. The
 * three states are the same three; what changed is that the middle one is now a sentence
 * somebody wrote about *this* tool instead of its name turning up in a comment.
 */
const declaring = (kind) => `#!/usr/bin/env node\n/**\n * Does a thing.\n *\n * @grant ${kind}\n */\n`;

check('a tool that declares itself granted is granted', () => {
  assert.deepEqual(allowlistStatus('b7e-granted', declaring('read')), { granted: true, decided: true });
  assert.deepEqual(allowlistStatus('b7e-granted', declaring('write')), { granted: true, decided: true });
});

check('a tool that declares itself excluded is decided-but-not-granted', () => {
  assert.deepEqual(allowlistStatus('b7e-excluded', declaring('excluded')), { granted: false, decided: true });
});

check('a tool that declares nothing is undecided', () => {
  assert.deepEqual(allowlistStatus('b7e-nevermentioned', '#!/usr/bin/env node\n/** Does a thing. */\n'), {
    granted: false,
    decided: false,
  });
});

check('and being named in somebody else prose is not a decision about it', () => {
  // The reading this replaced could not tell the two apart: a tool mentioned inside
  // another tool's paragraph read as decided, which is a decision nobody made. That is
  // why b7e-say showed as settled in some readings and unpaid in b7e-enroll's.
  const mentions = '#!/usr/bin/env node\n/**\n * Like `b7e-excluded`, but not.\n */\n';
  assert.deepEqual(allowlistStatus('b7e-excluded', mentions), { granted: false, decided: false });
});

/* ---------------------------------------------------------------- readmeAnchorFor */

console.log('\nreadmeAnchorFor');

const README_ANALYSIS = analyze('# Beadcause\n\n### One command runs the whole suite — `b7e-gate`\n\nprose\n\n### Something else entirely\n\nmore prose\n');

check('the heading backtick-quoting the name is found, with its slug', () => {
  const a = readmeAnchorFor('b7e-gate', README_ANALYSIS);
  assert.equal(a.title, 'One command runs the whole suite — `b7e-gate`');
  assert.equal(a.slug, 'one-command-runs-the-whole-suite--b7e-gate');
});

check('a name with no ### heading naming it is null', () => {
  assert.equal(readmeAnchorFor('b7e-nosection', README_ANALYSIS), null);
});

/* ---------------------------------------------------------------- ranking */

console.log('\nqueryTokens / scoreEntry / search');

check('stopwords are dropped, everything else lowercased', () => {
  assert.deepEqual(queryTokens('Is this Failure Mine?'), ['failure', 'mine']);
});

check('a name-word match outscores a question-only match, which outscores a body-only one', () => {
  const named = { name: 'b7e-suite', question: 'nothing relevant here.', usage: [], raw: '' };
  const questioned = { name: 'b7e-x', question: 'about the whole suite of tests.', usage: [], raw: '' };
  const bodied = { name: 'b7e-y', question: 'nothing relevant here either.', usage: [], raw: 'mentions suite once, in passing.' };
  const qTokens = queryTokens('suite');
  const sNamed = scoreEntry(named, qTokens);
  const sQuestioned = scoreEntry(questioned, qTokens);
  const sBodied = scoreEntry(bodied, qTokens);
  assert.ok(sNamed > sQuestioned, `${sNamed} > ${sQuestioned}`);
  assert.ok(sQuestioned > sBodied, `${sQuestioned} > ${sBodied}`);
});

check('exact-word matching does not let a query word match as a substring of a longer word', () => {
  const runners = { name: 'b7e-gates', question: 'which gate runners are on this Mac.', usage: [], raw: '' };
  assert.equal(scoreEntry(runners, queryTokens('run')), 0);
});

check('search drops zero-score entries and sorts the rest highest-first, ties by name', () => {
  const entries = [
    { name: 'b7e-b', question: 'suite suite.', usage: [], raw: '' },
    { name: 'b7e-a', question: 'suite once.', usage: [], raw: '' },
    { name: 'b7e-z', question: 'nothing to do with it.', usage: [], raw: '' },
  ];
  const results = search(entries, 'suite');
  assert.deepEqual(results.map((r) => r.name), ['b7e-a', 'b7e-b']);
});

check('a query of only stopwords matches nothing rather than everything', () => {
  const entries = [{ name: 'b7e-a', question: 'the is a of.', usage: [], raw: '' }];
  assert.deepEqual(search(entries, 'the is a'), []);
});

check('a malformed entry (no question) can still be searched against its name', () => {
  const entries = [{ name: 'b7e-gate', question: null, usage: [], raw: '', malformed: true }];
  assert.equal(search(entries, 'gate').length, 1);
});

/* ------------------------------------------------------------------------- fixture */

console.log('\nfullIndex and candidateNames, against a fabricated tree');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-which-'));
const write = (rel, text) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  fs.chmodSync(abs, 0o755);
};

// The `@grant` lines are what `allowlistStatus` reads since bc-wbrhi — granted on one,
// deliberately excluded on the other, and nothing at all on the third, which is the three
// states the index has to be able to tell apart.
write(
  'bin/b7e-foo',
  "#!/usr/bin/env node\n/**\n * `b7e-foo` — say the foo of a thing.\n *\n *   b7e-foo <name>   the foo\n *\n * @grant read\n */\nconsole.log('foo');\n"
);
write(
  'bin/b7e-bar',
  "#!/usr/bin/env node\n/**\n * `b7e-bar` — say the bar of a thing, and whether it is foo-shaped.\n *\n *   b7e-bar <name>   the bar\n *\n * @grant excluded\n */\nconsole.log('bar');\n"
);
// No docblock at all — the fixture's stand-in for "a command whose docblock does not
// open with its own name and a question".
write('bin/b7e-nodoc', "#!/usr/bin/env node\nconsole.log('nodoc');\n");

write(
  'package.json',
  JSON.stringify({ name: 'fixture', version: '0.0.0', bin: { 'b7e-foo': 'bin/b7e-foo', 'b7e-bar': 'bin/b7e-bar', 'b7e-nodoc': 'bin/b7e-nodoc' } })
);
write('README.md', '# Fixture\n\n### Say the foo of a thing — `b7e-foo`\n\nprose\n');

check('candidateNames is every bin/ entry package.json points to, sorted, not a written-down list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  assert.deepEqual(candidateNames(tmp, pkg), ['b7e-bar', 'b7e-foo', 'b7e-nodoc']);
});

check('a stray bin/ file with no package.json entry yet is still a candidate', () => {
  write('bin/b7e-stray', "#!/usr/bin/env node\n/**\n * `b7e-stray` — not registered anywhere yet.\n */\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  assert.deepEqual(candidateNames(tmp, pkg), ['b7e-bar', 'b7e-foo', 'b7e-nodoc', 'b7e-stray']);
  fs.rmSync(path.join(tmp, 'bin', 'b7e-stray'));
});

check('fullIndex reads all three: granted, decided-excluded, and undecided allowlist status', () => {
  const idx = fullIndex(tmp);
  const byName = Object.fromEntries(idx.map((e) => [e.name, e]));
  assert.deepEqual(byName['b7e-foo'].allowlist, { granted: true, decided: true });
  assert.deepEqual(byName['b7e-bar'].allowlist, { granted: false, decided: true });
  assert.deepEqual(byName['b7e-nodoc'].allowlist, { granted: false, decided: false });
});

check('fullIndex flags the docblock-less command malformed, with a null question, and still lists it', () => {
  const idx = fullIndex(tmp);
  const nodoc = idx.find((e) => e.name === 'b7e-nodoc');
  assert.equal(nodoc.question, null);
  assert.equal(nodoc.malformed, true);
});

check('fullIndex resolves the README anchor for the one command a heading names', () => {
  const idx = fullIndex(tmp);
  const byName = Object.fromEntries(idx.map((e) => [e.name, e]));
  assert.equal(byName['b7e-foo'].readme.slug, 'say-the-foo-of-a-thing--b7e-foo');
  assert.equal(byName['b7e-bar'].readme, null);
});

/* --------------------------------------------------------------------------- the CLI */

console.log('\nthe real command, spawned against the fixture');

const run = (args, cwd = ROOT) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('bare, against the fixture, lists exactly the three fixture commands, sorted', () => {
  const r = run(['--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 b7e-\* commands/);
  const iBar = r.stdout.indexOf('b7e-bar');
  const iFoo = r.stdout.indexOf('b7e-foo');
  const iNodoc = r.stdout.indexOf('b7e-nodoc');
  assert.ok(iBar > -1 && iFoo > -1 && iNodoc > -1, r.stdout);
  assert.ok(iBar < iFoo && iFoo < iNodoc, 'expected alphabetical order bar, foo, nodoc');
});

check('a new bin/ file appears in the count with no edit to this test or to lib/which.js', () => {
  write('bin/b7e-baz', "#!/usr/bin/env node\n/**\n * `b7e-baz` — a fourth fixture command, added mid-test.\n */\n");
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      version: '0.0.0',
      bin: { 'b7e-foo': 'bin/b7e-foo', 'b7e-bar': 'bin/b7e-bar', 'b7e-nodoc': 'bin/b7e-nodoc', 'b7e-baz': 'bin/b7e-baz' },
    })
  );
  const r = run(['--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 b7e-\* commands/);
  assert.match(r.stdout, /b7e-baz/);
});

check('--json prints one parseable object per command, question included', () => {
  const r = run(['--dir', tmp, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 4);
  const foo = rows.find((x) => x.name === 'b7e-foo');
  assert.equal(foo.question, 'say the foo of a thing.');
});

check('a query naming the malformed command by name still finds it (name always matches)', () => {
  const r = run(['nodoc', '--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /b7e-nodoc/);
});

check('a query matching nothing exits 0, not an error', () => {
  const r = run(['zzznothingmatchesthiszzz', '--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing matches/);
});

check('--dir pointing at something with no bin/ or package.json is refused', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-which-empty-'));
  const r = run(['--dir', empty]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not look like/);
  fs.rmSync(empty, { recursive: true, force: true });
});

check('more than one positional argument is refused as bad usage, not silently joined', () => {
  const r = run(['two', 'words', '--dir', tmp]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one query, quoted/);
});

check('--help exits 0 and prints usage without running anything', () => {
  const r = run(['--help', '--dir', tmp]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: b7e-which/);
});

check('an unrecognised flag is refused', () => {
  const r = run(['x', '--nope', '--dir', tmp]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag/);
});

await cleanupTmp(tmp);

/* ---------------------------------------------------- the real repo, this bead's own examples */

console.log("\nthe real command, spawned against this repo's own bin/ (the bead's own examples)");

check('the count is derived from bin/ on disk, matching an independent readdir, not a written-down number', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expected = candidateNames(ROOT, pkg).length;
  const r = run(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(rows.length, expected);
  assert.ok(expected > 40, `expected the real bin/ to carry well over 40 commands, found ${expected}`);
});

check('every real bin/b7e-* command is included and nothing else is', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expectedNames = candidateNames(ROOT, pkg);
  const r = run(['--json']);
  const gotNames = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).name).sort();
  assert.deepEqual(gotNames, expectedNames);
});

check('"run the whole suite" names b7e-gate above b7e-gates', () => {
  const r = run(['run the whole suite', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const iGate = rows.findIndex((x) => x.name === 'b7e-gate');
  const iGates = rows.findIndex((x) => x.name === 'b7e-gates');
  assert.ok(iGate !== -1, 'b7e-gate did not match at all');
  assert.ok(iGates === -1 || iGate < iGates, `expected b7e-gate ranked above b7e-gates, got indices ${iGate}, ${iGates}`);
});

check('"is this failure mine" names both b7e-blame and b7e-triage', () => {
  const r = run(['is this failure mine', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const names = new Set(r.stdout.trim().split('\n').map((l) => JSON.parse(l).name));
  assert.ok(names.has('b7e-blame'), 'b7e-blame was not named');
  assert.ok(names.has('b7e-triage'), 'b7e-triage was not named');
});

check('no real command is malformed — every one opens with a readable question', () => {
  const r = run(['--json']);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const bad = rows.filter((x) => x.malformed);
  assert.deepEqual(bad.map((x) => x.name), [], 'a real command has no docblock question to read');
});

check('b7e-which is on its own DEFAULT_TOOL_LIST — it only ever reads bin/ and README.md off disk', () => {
  const r = run(['--json']);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const self = rows.find((x) => x.name === 'b7e-which');
  assert.ok(self, 'b7e-which did not find itself in its own index');
  assert.equal(self.allowlist.granted, true, "b7e-which should be granted — see the @grant line in its own header");
});

/* --------------------------------------------------------------------------- done */

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
