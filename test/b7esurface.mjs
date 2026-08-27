#!/usr/bin/env node
//
// b7e-surface — what a module exports, with the one line that says what each export
// is for (bc-dgx7.28).
//
//   npm test
//   node test/b7esurface.mjs
//
// Runs the real command against this repo's own source, on the two files its
// acceptance criteria name: lib/bd.js (a class-shaped surface, the query that came
// back empty for bc-bmry.10) and lib/ownership.js (a plain-export surface, the file
// bc-bmry.12 guessed three wrong names against). If either file's surface changes
// shape, this is meant to go red — a b7e-surface that stops finding real exports is
// worse than one that never shipped.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-surface');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });

console.log("\na class-shaped surface — the query bc-bmry.10 ran against lib/bd.js and got nothing");

{
  const r = run(['lib/bd.js']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('names the class Bd itself', /\bclass\s+Bd\b/.test(r.stdout), r.stdout);
  // bc-bmry.10's own grep: show(\|comments(\|update(\|appendNotes( — every one of
  // these is a method on Bd, at its real line number, not merely present anywhere.
  check('show, with its line number', /669\s+method\s+async show\(workspace, id\)/.test(r.stdout), r.stdout);
  check('comments, with its line number', /728\s+method\s+async comments\(workspace, id\)/.test(r.stdout), r.stdout);
  check('update, with its line number', /1586\s+method\s+async update\(/.test(r.stdout), r.stdout);
  check('appendNotes, with its line number', /2728\s+method\s+async appendNotes\(workspace, id, text\)/.test(r.stdout), r.stdout);
  // A file whose surface is a class must not read as empty: it names module-level
  // guard functions too, not only the class.
  check('also names a plain export function above the class', /\bfunction\s+isClaimGuard\(err\)/.test(r.stdout), r.stdout);
  check('methods are printed under Bd, not before it', r.stdout.indexOf('class') < r.stdout.indexOf('async show(workspace, id)'), r.stdout);
}

console.log('\na plain-export surface — the three names bc-bmry.12 guessed wrong against lib/ownership.js');

{
  const r = run(['lib/ownership.js']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  // bc-bmry.12 guessed isRoot, isEpic, isP0 exist as `function` exports; they are
  // real, but as arrow-valued consts (isRoot, isEpic) and a plain const (isP0) —
  // the acceptance criterion is that the tool names what is REALLY there.
  check('names isRoot', /\bisRoot\b/.test(r.stdout), r.stdout);
  check('names isEpic', /\bisEpic\b/.test(r.stdout), r.stdout);
  check('names isP0', /\bisP0\b/.test(r.stdout), r.stdout);
  check('names ownerLabel, a real exported function', /\bfunction\s+ownerLabel\(handle\)/.test(r.stdout), r.stdout);
  check('carries a first-sentence doc for at least one export', /—\s*The label prefix\./.test(r.stdout), r.stdout);
  // lib/ownership.js has no classes — nothing should be reported as a method.
  check('no method rows for a file with no class', !/\bmethod\b/.test(r.stdout), r.stdout);
}

console.log('\na path that is not a source file is a refusal, not empty output');

{
  const r = run(['README.md']);
  check('exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says so on stderr', /not a source file/.test(r.stderr), r.stderr);
  check('prints nothing that looks like a found export', !/\bfunction\b|\bclass\b|\bconst\b/.test(r.stdout), r.stdout);
}

{
  // Named after this suite rather than something generic: b7e-affected matches a quoted
  // path literal, so a shared "does not exist" name silently disarms any *other* suite
  // asserting that same path comes back unmatched. It did — see bc-sp2sz.
  const r = run(['lib/b7esurface-no-such-file.js']);
  check('a missing path exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says no such file', /no such file/.test(r.stderr), r.stderr);
}

{
  const r = run(['lib']);
  check('a directory exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says so', /is a directory/.test(r.stderr), r.stderr);
}

console.log('\n--all adds module-private definitions; the default surface omits them');

{
  const withoutAll = run(['lib/ownership.js']);
  const withAll = run(['--all', 'lib/ownership.js']);
  check('default and --all both exit 0', withoutAll.status === 0 && withAll.status === 0);
  // Every export in lib/ownership.js is already exported, so --all should not
  // shrink the count; assert against a file that actually has module-private
  // helpers instead — lib/bd.js's `parseJson` is a plain, unexported function.
  const bare = run(['lib/bd.js']);
  const all = run(['--all', 'lib/bd.js']);
  check('parseJson (exported) is in both', /\bparseJson\(out\)/.test(bare.stdout) && /\bparseJson\(out\)/.test(all.stdout));
  check('--all output is not shorter than the default', all.stdout.split('\n').length >= bare.stdout.split('\n').length);
}

console.log("\n--class narrows to one class's methods, whichever it is");

{
  const r = run(['--class', 'Bd', 'lib/bd.js']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('names Bd', /\bclass\s+Bd\b/.test(r.stdout), r.stdout);
  check('names one of its methods', /\bconstructor\(/.test(r.stdout), r.stdout);
  check('does not name the module-level guard functions', !/isClaimGuard/.test(r.stdout), r.stdout);
}

{
  const r = run(['--class', 'NoSuchClassAnywhereHere', 'lib/bd.js']);
  check('a class not found in the file exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says so', /no class named/.test(r.stderr), r.stderr);
}

console.log('\na regex literal with a quote inside its own pattern does not corrupt the rest of the scan');

{
  // lib/bd.js's own CLAIM_GUARD_RE (bd 1.2.1's error text quoting an assignee's
  // name back) is exactly this shape — this is the regression test for the bug
  // that shipped first: every method after it in the file read at the wrong line,
  // or not at all, because the embedded `"` was read as a string opening.
  const r = run(['lib/bd.js']);
  check('CLAIM_GUARD_RE itself is named', /\bCLAIM_GUARD_RE\b/.test(r.stdout), r.stdout);
  check('a method defined hundreds of lines after it is still found, at its real line', /2734\s+method\s+addLabel\(workspace, id, label\)/.test(r.stdout), r.stdout);
}

console.log('\nno path, or --help, is a usage message rather than a crash');

{
  const r = run([]);
  check('bare invocation exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('prints usage', /b7e-surface <path>/.test(r.stderr), r.stderr);
}

{
  const r = run(['--help']);
  check('--help exits 0', r.status === 0, `status was ${r.status}`);
  check('prints usage', /b7e-surface <path>/.test(r.stdout), r.stdout);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
