#!/usr/bin/env node
/**
 * `b7e-apply` — the anchored edit, applied all-or-nothing and syntax-checked.
 *
 *     npm test
 *     node test/b7eapply.mjs
 *
 * This spawns the real binary, the way a worker session actually invokes it, against
 * real files in a scratch directory. Nothing here fakes the filesystem or the parser —
 * the whole point of the command is that its guarantees hold against actual `node
 * --check` and an actual write, not against a model of either.
 *
 * The acceptance criteria bc-khoe.27.6 was filed with are the two shapes below: a patch
 * of several anchors across several files applying in one call and reporting a line per
 * anchor, and the same patch with one anchor wrong writing nothing at all, naming the
 * bad anchor, and exiting non-zero. A third — a `.js` edit left unparseable is caught
 * here rather than by the next `npm test` — is the reuse of `lib/conflicted.js`'s
 * `parseError`, so it is checked directly too.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-apply');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eapply-'));

const run = (args) => {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: tmp });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};
const read = (name) => fs.readFileSync(path.join(tmp, name), 'utf8');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

console.log('\nan anchored edit, applied all-or-nothing and syntax-checked\n');

/* --------------------------------------------------------------- the acceptance case */

check('four anchors across three files apply in one call and report four line numbers', () => {
  write('app.js', 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n');
  write('style.css', '.x { color: red; }\n');
  write('README.md', '# Title\n\nSome prose.\n');
  const patch = write(
    'patch.yaml',
    [
      '- file: app.js',
      '  anchor: "return 1;"',
      '  to: "return 10;"',
      '- file: app.js',
      '  anchor: "return 2;"',
      '  to: "return 20;"',
      '- file: style.css',
      '  anchor: "color: red;"',
      '  to: "color: blue;"',
      '- file: README.md',
      '  anchor: "Some prose."',
      '  to: "Some other prose."',
      '',
    ].join('\n')
  );
  const { status, out, err } = run(['--patch', path.basename(patch)]);
  assert.equal(status, 0, err);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 4, out);
  assert.match(read('app.js'), /return 10;/);
  assert.match(read('app.js'), /return 20;/);
  assert.match(read('style.css'), /color: blue;/);
  assert.match(read('README.md'), /Some other prose\./);
});

check('--dry prints the same plan and writes nothing', () => {
  write('dry.txt', 'alpha\nbeta\n');
  const patch = write('drypatch.yaml', '- file: dry.txt\n  anchor: "beta"\n  to: "BETA"\n');
  const { status, out } = run(['--patch', path.basename(patch), '--dry']);
  assert.equal(status, 0);
  assert.match(out, /dry\.txt:2/);
  assert.equal(read('dry.txt'), 'alpha\nbeta\n', 'dry run must not touch the file');
});

check('a mistyped anchor writes nothing at all — including edits earlier in the same patch — names it, and exits non-zero', () => {
  const before = write('miss.txt', 'one\ntwo\nthree\n');
  const beforeText = fs.readFileSync(before, 'utf8');
  const patch = write(
    'misspatch.yaml',
    '- file: miss.txt\n  anchor: "two"\n  to: "TWO"\n- file: miss.txt\n  anchor: "this text is not in the file"\n  to: "x"\n'
  );
  const { status, err } = run(['--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /this text is not in the file/);
  assert.match(err, /matched 0 times/);
  assert.equal(fs.readFileSync(before, 'utf8'), beforeText, 'the first, valid edit must not have landed either');
});

check('an anchor matching twice is refused the same way — count and nothing written', () => {
  const before = write('dupe.txt', 'dup\ndup\n');
  const patch = write('dupepatch.yaml', '- file: dupe.txt\n  anchor: "dup"\n  to: "DUP"\n');
  const beforeText = fs.readFileSync(before, 'utf8');
  const { status, err } = run(['--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /matched 2 times/);
  assert.equal(fs.readFileSync(before, 'utf8'), beforeText);
});

check('a zero-match anchor names the nearest line by word overlap', () => {
  write('near.txt', 'the quick brown fox\njumps over the lazy dog\n');
  const patch = write('nearpatch.yaml', '- file: near.txt\n  anchor: "the quick brown fx"\n  to: "x"\n');
  const { err } = run(['--patch', path.basename(patch)]);
  assert.match(err, /nearest: near\.txt:1/);
});

/* -------------------------------------------------------------------- the syntax gate */

check('a .js edit left unparseable is caught here, not by the next suite run — and nothing is written', () => {
  const target = write('broken.js', 'function f() {\n  return 1;\n}\n');
  const beforeText = fs.readFileSync(target, 'utf8');
  const patch = write('brokenpatch.yaml', '- file: broken.js\n  anchor: "function f() {"\n  to: "function f( {"\n');
  const { status, err } = run(['--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /does not parse/);
  assert.equal(fs.readFileSync(target, 'utf8'), beforeText);
});

check('a .js edit that stays parseable is written and gated silently', () => {
  write('ok.js', 'const x = 1;\n');
  const patch = write('okpatch.yaml', '- file: ok.js\n  anchor: "const x = 1;"\n  to: "const x = 2;"\n');
  const { status } = run(['--patch', path.basename(patch)]);
  assert.equal(status, 0);
  assert.match(read('ok.js'), /const x = 2;/);
});

/* ---------------------------------------------------------------------- single-pair mode */

check('--file --anchor --to applies one edit without a patch file', () => {
  write('single.txt', 'before\n');
  const { status } = run(['--file', 'single.txt', '--anchor', 'before', '--to', 'after']);
  assert.equal(status, 0);
  assert.equal(read('single.txt'), 'after\n');
});

check('a single edit missing --to is a usage error, nothing spawned against a file', () => {
  write('partial.txt', 'x\n');
  const { status, err } = run(['--file', 'partial.txt', '--anchor', 'x']);
  assert.notEqual(status, 0);
  assert.match(err, /needs --file, --anchor and --to/);
});

check('mixing --file with --patch is refused rather than silently picking one', () => {
  write('mix.txt', 'x\n');
  const patch = write('mixpatch.yaml', '- file: mix.txt\n  anchor: "x"\n  to: "y"\n');
  const { status, err } = run(['--file', 'mix.txt', '--anchor', 'x', '--to', 'y', '--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /two different ways in/);
});

/* --------------------------------------------------------------------------- odds */

check('a patch naming a file that does not exist is refused, not a crash', () => {
  const patch = write('ghostpatch.yaml', '- file: does-not-exist.txt\n  anchor: "x"\n  to: "y"\n');
  const { status, err } = run(['--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /no such file/);
});

check('invalid YAML is refused with the parser error, not a stack trace', () => {
  const patch = write('badyaml.yaml', ': not: valid: [yaml\n');
  const { status, err } = run(['--patch', path.basename(patch)]);
  assert.notEqual(status, 0);
  assert.match(err, /not valid YAML/);
});

check('edits to the same file chain — the second anchor sees the first replacement', () => {
  write('chain.txt', 'AAA\n');
  const patch = write(
    'chainpatch.yaml',
    '- file: chain.txt\n  anchor: "AAA"\n  to: "BBB"\n- file: chain.txt\n  anchor: "BBB"\n  to: "CCC"\n'
  );
  const { status } = run(['--patch', path.basename(patch)]);
  assert.equal(status, 0);
  assert.equal(read('chain.txt'), 'CCC\n');
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
