#!/usr/bin/env node
//
// b7e-scaffold — the house skeleton for a new bin/ command, instead of reading three
// siblings to copy it.
//
//   npm test
//   node test/scaffold.mjs
//
// bc-dgx7.32. Two halves: the templates in lib/scaffold.js are driven directly (fast,
// and it is where the actual text lives), and bin/b7e-scaffold is driven as a real
// subprocess for its argv handling and its refusals — the same split test/b7efield.mjs
// uses for bin/b7e-field.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-scaffold');

const { nameProblem, scaffoldBin, scaffoldLib, scaffold } = await import(path.join(ROOT, 'lib', 'scaffold.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-scaffold-'));
process.on('exit', () => removeTreeSync(tmp));

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

/** Writes text to a fresh scratch file with no extension and runs `node --check` on it. */
function checksAsJs(text, label) {
  const file = path.join(tmp, `check-${label}-${ran}`);
  fs.writeFileSync(file, text);
  execFileSync(process.execPath, ['--check', file]);
}

/* --------------------------------------------------------------------- lib/scaffold.js */

console.log('\nlib/scaffold.js — the templates');

check('nameProblem rejects a missing name, a bare word, and an upper/underscore name; accepts b7e-<word> and b7e-multi-word', () => {
  assert.match(nameProblem(null), /command name is required/);
  assert.match(nameProblem(''), /command name is required/);
  assert.match(nameProblem('thing'), /doesn't look like a b7e-\* command name/);
  assert.match(nameProblem('B7e-thing'), /doesn't look like/);
  assert.match(nameProblem('b7e-Thing'), /doesn't look like/);
  assert.match(nameProblem('b7e_thing'), /doesn't look like/);
  assert.equal(nameProblem('b7e-thing'), null);
  assert.equal(nameProblem('b7e-multi-word'), null);
});

check('scaffoldBin(bare) parses as JS, has a shebang, and carries a TODO grant rather than a decided one', () => {
  const text = scaffoldBin('b7e-thing');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'), 'no shebang');
  checksAsJs(text, 'bare');
  // The GRANT_RE in lib/tooldecl.js only matches a line that IS "@grant <word>" at the
  // start of a comment line — the TODO prose must not accidentally satisfy it, or a
  // scaffolded-but-unfinished command would silently read as a decided grant.
  assert.ok(!/^[ \t]*(?:\*|\/\/)?[ \t]*@grant[ \t]+\S+[ \t]*$/m.test(text), 'the TODO grant text matches the real @grant declaration pattern');
  assert.match(text, /TODO: decide the grant/);
  assert.match(text, /@grant read/); // named as an option inside the TODO prose
  assert.match(text, /@grant write/);
  assert.match(text, /@grant excluded/);
});

check('scaffoldBin(bare) has no -w/-b parsing and no --json branch', () => {
  const text = scaffoldBin('b7e-thing');
  assert.ok(!text.includes("loadConfig"), 'bare template pulled in the workspace-arg block');
  assert.ok(!text.includes('JSON_MODE'), 'bare template pulled in the json-mode block');
});

check('scaffoldBin(..., {workspaceArg: true}) parses as JS and carries the -w/-b block', () => {
  const text = scaffoldBin('b7e-thing', { workspaceArg: true });
  checksAsJs(text, 'wsarg');
  assert.match(text, /import \{ loadConfig \} from '\.\.\/lib\/config\.js';/);
  assert.match(text, /import \{ Bd \} from '\.\.\/lib\/bd\.js';/);
  assert.match(text, /-w' \|\| a === '--workspace'/);
  assert.match(text, /-b' \|\| a === '--bead'/);
  assert.match(text, /no such workspace/);
  assert.match(text, /usage: b7e-thing -w <workspace> -b <bead>/);
});

check('scaffoldBin(..., {jsonMode: true}) parses as JS and carries a --json branch, named in its own usage', () => {
  const text = scaffoldBin('b7e-thing', { jsonMode: true });
  checksAsJs(text, 'json');
  assert.match(text, /JSON_MODE/);
  assert.match(text, /--json/);
});

check('every variant answers -h/--help before touching any TODO-shaped code', () => {
  for (const opts of [{}, { workspaceArg: true }, { jsonMode: true }, { workspaceArg: true, jsonMode: true }]) {
    const text = scaffoldBin('b7e-thing', opts);
    const helpIdx = text.indexOf("argvIn.includes('-h')");
    const todoWorkIdx = text.indexOf("command's own work");
    assert.ok(helpIdx !== -1, 'no -h/--help check at all');
    assert.ok(todoWorkIdx === -1 || helpIdx < todoWorkIdx, '-h/--help check comes after the TODO work section');
  }
});

check('scaffoldBin exit-code convention is 2 for refused, matching the b7e-* majority', () => {
  const text = scaffoldBin('b7e-thing', { workspaceArg: true });
  assert.match(text, /Exit codes: `0` ok\. `2` refused/);
  assert.match(text, /process\.exit\(2\)/);
});

check('scaffoldLib prints a module that parses as JS and notes the CONFIG_DIR/evidence.js obligation', () => {
  const text = scaffoldLib('thing', 'b7e-thing');
  checksAsJs(text, 'lib');
  assert.match(text, /lib\/evidence\.js/);
  assert.match(text, /CONFIG_DIR/);
  assert.match(text, /test\/evidence\.mjs/);
});

check('scaffold(name) with no lib option returns exactly scaffoldBin — redirect-ready', () => {
  assert.equal(scaffold('b7e-thing'), scaffoldBin('b7e-thing'));
  assert.equal(scaffold('b7e-thing', { workspaceArg: true }), scaffoldBin('b7e-thing', { workspaceArg: true, jsonMode: false }));
});

check('scaffold(name, {lib: true}) appends a clearly-marked second file, naming both save paths', () => {
  const text = scaffold('b7e-thing', { lib: true });
  assert.ok(text.startsWith(scaffoldBin('b7e-thing')), 'the bin file section changed when lib was added');
  assert.match(text, /Save the section above as bin\/b7e-thing\./);
  assert.match(text, /Save it as lib\/thing\.js\./);
  assert.ok(text.includes(scaffoldLib('thing', 'b7e-thing')), 'the lib stub is not the same text scaffoldLib prints on its own');
});

/* -------------------------------------------------------------------- bin/b7e-scaffold */

console.log('\nbin/b7e-scaffold — argv and refusals');

check('bin/b7e-scaffold is executable, extensionless, and has a shebang', () => {
  assert.ok(fs.existsSync(BIN), 'bin/b7e-scaffold is missing');
  assert.ok(fs.statSync(BIN).mode & 0o111, 'bin/b7e-scaffold is not executable');
  assert.ok(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node'), 'no shebang');
});

check('--help prints usage and exits 0, with no name required', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: b7e-scaffold <name>/);
});

check('no arguments refuses with 2 and names what is missing', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a command name is required/);
});

check('a name not shaped like b7e-* refuses with 2', () => {
  const r = run(['thing']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /doesn't look like a b7e-\* command name/);
});

check('a name colliding with an existing bin/ file refuses with 2, rather than printing over it', () => {
  const r = run(['b7e-field']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bin\/b7e-field already exists/);
});

check('two names on the argv refuses with 2', () => {
  const r = run(['b7e-thing', 'b7e-other']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only one command name at a time/);
});

check('an unrecognised flag refuses with 2', () => {
  const r = run(['b7e-thing', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag: --nope/);
});

check('a bare name prints exactly what lib/scaffold.js would, and exits 0', () => {
  const r = run(['b7e-thing']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, scaffoldBin('b7e-thing'));
});

check('--workspace-arg --json-mode composes both blocks and still prints exit 0', () => {
  const r = run(['b7e-thing', '--workspace-arg', '--json-mode']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, scaffoldBin('b7e-thing', { workspaceArg: true, jsonMode: true }));
});

check('--lib appends the lib stub to stdout, matching lib/scaffold.js exactly', () => {
  const r = run(['b7e-thing', '--lib']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, scaffold('b7e-thing', { lib: true }));
});

/* ----------------------------------------------- the acceptance criterion, worked through */

console.log('\nthe acceptance criterion — dropped in and registered');

check('b7e-scaffold b7e-thing --workspace-arg, dropped into bin/ and run, exits 0 on --help and 2 on a missing -w/-b — the same shape test/eyeball.mjs checks for a real command', () => {
  const gen = run(['b7e-thing', '--workspace-arg']);
  assert.equal(gen.status, 0);

  const scratch = fs.mkdtempSync(path.join(tmp, 'dropin-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  const target = path.join(scratch, 'bin', 'b7e-thing');
  fs.writeFileSync(target, gen.stdout);
  fs.chmodSync(target, 0o755);
  // A real -w/-b command imports lib/config.js and lib/bd.js by relative path — symlink
  // the real lib/ in so those resolve, the same way the generated file will once it is
  // actually placed at bin/<name> in this checkout.
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(scratch, 'lib'));

  // Same three assertions test/eyeball.mjs's "the registrations a new bin/ command owes"
  // block makes, run here against a file this command produced rather than one someone
  // hand-wrote.
  assert.ok(fs.statSync(target).mode & 0o111, 'generated file lost its executable bit on disk');
  assert.ok(fs.readFileSync(target, 'utf8').startsWith('#!/usr/bin/env node'), 'generated file has no shebang');
  execFileSync(process.execPath, ['--check', target]);

  const help = spawnSync(process.execPath, [target, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, `--help did not exit 0: ${help.stderr}`);
  assert.match(help.stdout, /usage: b7e-thing -w <workspace> -b <bead>/);

  const missing = spawnSync(process.execPath, [target], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /-w\/--workspace and -b\/--bead are both required/);
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
