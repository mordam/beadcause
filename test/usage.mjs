#!/usr/bin/env node
//
// b7e-usage — what a repo command takes, without running it to find out (bc-dgx7.31).
// Six sessions each needed a bin/ command's flags and got them a different way, twice
// by starting the command for real with --help and once by running it bare to see what
// happened. `lib/usage.js` reads a command's header doc comment as text; this suite
// pins the parsing (the name-dash pattern, the plain-prose pattern, the invocation
// block, the trailing Flags: paragraph, the exit codes) and drives `bin/b7e-usage`
// itself as a real subprocess against this repo's own bin/ and package.json, since
// those are the fixture that actually matters here — there is no smaller one that
// would still prove path and name resolve to the same command.
//
//   npm test
//   node test/usage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headerLines, parseUsage, loadBinMap, resolveCommand, ROOT as LIB_ROOT } from '../lib/usage.js';
import { DEFAULT_TOOL_LIST } from '../lib/tooldecl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-usage');

let failures = 0;
let ran = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const run = (...args) => execFileSync('node', [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });
const runFails = (...args) => {
  try {
    run(...args);
    return null;
  } catch (err) {
    return err;
  }
};

/* --------------------------------------------------------------------- lib/usage.js */

console.log('\nlib/usage.js — reading a header doc comment as text');

check('ROOT is this checkout, the tree b7e-usage belongs to', () => {
  assert.equal(LIB_ROOT, ROOT);
});

check('headerLines strips the shebang and the * prefix, keeps blank lines as blank', () => {
  const src = '#!/usr/bin/env node\n/**\n * line one\n *\n * line two\n */\nimport x from "y";\n';
  assert.deepEqual(headerLines(src), ['line one', '', 'line two']);
});

check('a file with no leading doc comment yields no header lines at all', () => {
  assert.deepEqual(headerLines('#!/usr/bin/env node\nconst x = 1;\n'), []);
});

check('the name-dash pattern is the summary, dash and backticks dropped', () => {
  const src = '#!/usr/bin/env node\n/**\n * `b7e-thing` — does the one thing.\n *\n *   b7e-thing --flag\n */\n';
  const { summary } = parseUsage(src, 'b7e-thing');
  assert.equal(summary, 'does the one thing.');
});

check('plain prose with no name-dash pattern takes its first sentence', () => {
  const src =
    '#!/usr/bin/env node\n/**\n * Land finished work: push it, open the pull request. A second sentence.\n *\n *   thing -x\n */\n';
  const { summary } = parseUsage(src, 'thing');
  assert.equal(summary, 'Land finished work: push it, open the pull request.');
});

check('invocation is matched against the REGISTERED name, not the filename', () => {
  // bin/b7e-owes.js writes its examples as `b7e-owes ...` — the package.json key, not
  // b7e-owes.js — and every renamed file in the family (b7e-say.js, deliver.js, ...)
  // does the same, which is why parseUsage takes the name as an argument.
  const src = '#!/usr/bin/env node\n/**\n * a thing.\n *\n *   b7e-owes --rev x\n */\n';
  assert.deepEqual(parseUsage(src, 'b7e-owes').invocation, ['  b7e-owes --rev x']);
  assert.deepEqual(parseUsage(src, 'b7e-owes.js').invocation, []);
});

check('two example paragraphs both starting with the name are both kept, blank-separated', () => {
  const src = '#!/usr/bin/env node\n/**\n * a thing.\n *\n *   b7e-x one\n *\n *   b7e-x two\n *\n * not an example.\n */\n';
  assert.deepEqual(parseUsage(src, 'b7e-x').invocation, ['  b7e-x one', '', '  b7e-x two']);
});

check('a trailing Flags: paragraph is appended even though it does not open with the name', () => {
  const src = '#!/usr/bin/env node\n/**\n * a thing.\n *\n *   b7e-x --a\n *\n * Flags:\n *   --a   does a thing\n */\n';
  assert.deepEqual(parseUsage(src, 'b7e-x').invocation, ['  b7e-x --a', '', 'Flags:', '  --a   does a thing']);
});

check('exit codes are matched case-insensitively, anywhere in the header, not just after invocation', () => {
  const src =
    '#!/usr/bin/env node\n/**\n * a thing.\n *\n *   b7e-x\n *\n * some unrelated prose paragraph.\n *\n * EXIT CODE is a linter\'s: 0 clean, 1 dirty.\n */\n';
  assert.equal(parseUsage(src, 'b7e-x').exitCodes, "EXIT CODE is a linter's: 0 clean, 1 dirty.");
});

check('no Exit code paragraph at all is null, not an empty string or a throw', () => {
  const src = '#!/usr/bin/env node\n/**\n * a thing.\n *\n *   b7e-x\n */\n';
  assert.equal(parseUsage(src, 'b7e-x').exitCodes, null);
});

check('loadBinMap reads this repo\'s real package.json bin map', () => {
  const bin = loadBinMap();
  assert.equal(bin['b7e-gate'], 'bin/b7e-gate');
  assert.equal(bin['b7e-usage'], 'bin/b7e-usage');
});

check('resolveCommand: a registered name resolves', () => {
  assert.deepEqual(resolveCommand('b7e-gate'), { name: 'b7e-gate', relPath: 'bin/b7e-gate' });
});

check('resolveCommand: the path it is registered under resolves to the same name', () => {
  assert.deepEqual(resolveCommand('bin/b7e-owes.js'), { name: 'b7e-owes', relPath: 'bin/b7e-owes.js' });
});

check('resolveCommand: an unregistered name or path is null, not a guess', () => {
  assert.equal(resolveCommand('not-a-real-command'), null);
  assert.equal(resolveCommand('bin/not-a-real-file.js'), null);
});

/* --------------------------------------------------------------------- bin/b7e-usage */

console.log('\nbin/b7e-usage — the argv and the printing, driven for real\n');

check('--help prints without touching argument parsing further down', () => {
  const out = run('--help');
  assert.match(out, /every command in package\.json's bin map/);
});

check('with no argument, every package.json bin entry is listed, one line each', () => {
  const out = run();
  const bin = loadBinMap();
  const names = Object.keys(bin);
  assert.ok(names.length > 60, 'sanity: package.json bin map looks too small to be real');
  for (const name of names) {
    assert.match(out, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm'), `${name} missing from the roster`);
  }
});

check('--json with no argument is one JSON array, one object per bin entry, name and summary both', () => {
  const out = run('--json');
  const roster = JSON.parse(out);
  assert.ok(Array.isArray(roster));
  const row = roster.find((r) => r.name === 'b7e-gate');
  assert.ok(row, 'b7e-gate missing from --json roster');
  assert.equal(row.path, 'bin/b7e-gate');
  assert.match(row.summary, /without bailing at the first red/);
});

check('b7e-usage b7e-gate prints its invocation lines and its exit codes — fast, no lock, no run', () => {
  const gateRunsDir = path.join(ROOT, '.claude', 'gate-runs');
  const before = fs.existsSync(gateRunsDir) ? new Set(fs.readdirSync(gateRunsDir)) : new Set();
  const start = Date.now();
  const out = run('b7e-gate');
  const elapsedMs = Date.now() - start;
  // A real b7e-gate run takes minutes; reading its header takes milliseconds. This is
  // the load-bearing assertion — the acceptance criterion is "without any suite
  // running and without a lock being taken", and elapsed time is what proves it
  // without needing to know where a lock file lives.
  assert.ok(elapsedMs < 5000, `took ${elapsedMs}ms — that is not a static read of a doc comment`);
  const after = fs.existsSync(gateRunsDir) ? new Set(fs.readdirSync(gateRunsDir)) : new Set();
  assert.deepEqual([...after].filter((f) => !before.has(f)), [], 'a new gate-runs file appeared — b7e-gate actually ran');
  for (const line of [
    'b7e-gate --only test/gate.mjs --only test/b7e*.mjs',
    'b7e-gate --skip test/browse.mjs',
    'b7e-gate --jobs 4',
    'b7e-gate --timeout 120',
    'b7e-gate --json',
    'b7e-gate --log /path/to/gate.log',
    'b7e-gate --list',
    'b7e-gate --dir <root>',
  ]) {
    assert.ok(out.includes(line), `missing invocation line: ${line}`);
  }
  assert.match(out, /Exit codes:.*`0`.*`1`.*`2`/s, 'not all three exit codes are printed');
});

check('a command given by path resolves the same as by name', () => {
  assert.equal(run('bin/b7e-owes.js'), run('b7e-owes'));
});

check('--json for one command is a single object, not the roster array', () => {
  const parsed = JSON.parse(run('b7e-affected', '--json'));
  assert.equal(parsed.name, 'b7e-affected');
  assert.equal(parsed.path, 'bin/b7e-affected');
  assert.ok(Array.isArray(parsed.invocation) && parsed.invocation.length > 0);
  assert.ok(parsed.exitCodes);
});

check('an unregistered name exits 2 and names what was asked for', () => {
  const err = runFails('definitely-not-a-registered-command');
  assert.ok(err, 'expected a non-zero exit');
  assert.equal(err.status, 2);
  assert.match(err.stderr, /definitely-not-a-registered-command/);
});

check('more than one command at a time is refused, not silently narrowed to the first', () => {
  const err = runFails('b7e-gate', 'b7e-affected');
  assert.ok(err);
  assert.equal(err.status, 2);
});

/* --------------------------------------------------------------------- registrations */

console.log('\nthe registrations a new bin/ command owes');

check('bin/b7e-usage is executable, extensionless, and has a shebang', () => {
  assert.ok(fs.existsSync(BIN), 'bin/b7e-usage is missing');
  assert.ok(fs.statSync(BIN).mode & 0o111, 'bin/b7e-usage is not executable');
  assert.ok(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node'), 'no shebang');
});

check('it is registered in package.json AND in package-lock.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-usage'], 'bin/b7e-usage');
  assert.equal(lock.packages[''].bin['b7e-usage'], 'bin/b7e-usage');
});

check('the README says it exists — a feature is not finished here until it does', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^### .*`b7e-usage`/m, 'no ### section names b7e-usage');
});

check('it declares @grant read, and DEFAULT_TOOL_LIST (derived from that) carries it', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  assert.match(src, /^\s*\*\s*@grant read\s*$/m, 'b7e-usage no longer declares @grant read');
  assert.ok(DEFAULT_TOOL_LIST.includes('Bash(b7e-usage:*)'), 'b7e-usage is not on DEFAULT_TOOL_LIST despite @grant read');
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
