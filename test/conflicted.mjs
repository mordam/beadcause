// Does the conflict guard catch a committed merge marker — and only that?
//
// Two halves, and the second is the one worth the file. The first asserts that a
// conflict marker in a committed blob is found: easy, and it would pass against a
// one-line grep. The second asserts what it does *not* find, which is the whole
// difficulty of this check — `=======` under a Markdown heading, seven `<` in the
// middle of a line, a binary file whose bytes happen to line up, a file the branch
// deleted. A guard that refuses a delivery it should not is worse than no guard, because
// the answer to it is to take it out.
//
// It runs against real git: a scratch repo under /tmp with real commits, because the
// thing being tested is "the committed blob, not the working tree" and there is no way
// to assert that without a commit to be wrong about.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MARKER_RE,
  inspectBranch,
  inspectCommit,
  inspectStaged,
  isBinary,
  markersIn,
  parseError,
  report,
} from '../lib/conflicted.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-conflicted-'));
const repo = path.join(tmp, 'repo');

const git = (args, cwd = repo) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // stderr piped rather than inherited: one check below deliberately trips the
    // pre-commit hook, and its refusal would otherwise print into this suite's own
    // output, where a passing run would read as a failing one.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

/* --------------------------------------------------------------- the marker itself */

console.log('\nwhat counts as a marker');

check('the three git writes, at the start of a line', () => {
  assert.ok(MARKER_RE.test('<<<<<<< HEAD'));
  assert.ok(MARKER_RE.test('>>>>>>> origin/main'));
  assert.ok(MARKER_RE.test('||||||| merged common ancestors'));
  assert.ok(MARKER_RE.test('<<<<<<<'), 'bare, with nothing after it');
});

check('`=======` is not one of them — it is a Markdown h1 underline', () => {
  assert.equal(markersIn('A heading\n=======\n\ntext\n').length, 0);
});

check('seven, not six and not twenty', () => {
  assert.equal(markersIn('<<<<<< six\n').length, 0);
  assert.equal(markersIn('<<<<<<<<<<<<<<<<<<<< a rule\n').length, 0, 'twenty is a divider somebody drew');
});

check('and only at the start of a line', () => {
  assert.equal(markersIn('const shift = a <<<<<<< b;\n').length, 0);
  assert.equal(markersIn('  <<<<<<< HEAD\n').length, 0, 'git never indents one');
});

check('every marker is reported, with its line number', () => {
  const found = markersIn('one\n<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> other\n');
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.line), [2, 6]);
  assert.equal(found[0].text, '<<<<<<< HEAD');
});

check('CRLF does not hide one', () => {
  assert.equal(markersIn('a\r\n<<<<<<< HEAD\r\n').length, 1);
});

check('a NUL in the first 8000 bytes means binary', () => {
  assert.equal(isBinary(Buffer.from('plain text')), false);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e])), true);
});

/* ---------------------------------------------------------------------- node --check */

console.log('\nand what still parses');

check('a good file parses', () => {
  assert.equal(parseError('export const a = 1;\n', 'a.js'), null);
  assert.equal(parseError('const a = require("b");\n', 'a.js'), null);
});

check('a conflicted one does not, and node says why', () => {
  const err = parseError('<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> b\n', 'a.js');
  assert.ok(err, 'expected an error');
  assert.match(err, /SyntaxError/);
});

check('the error names the real file, not the temp one', () => {
  const err = parseError('const = ;\n', 'public/console.js');
  assert.ok(err, 'expected an error');
  assert.doesNotMatch(err, /beadcause-parse-/, `leaked a temp path: ${err}`);
});

/* --------------------------------------------------------------------- against git */

console.log('\nagainst a real repo, reading the committed blob');

git(['init', '-q', '-b', 'main', repo], tmp);
write('good.js', 'export const a = 1;\n');
write('README.md', 'Beadcause\n=========\n\nA heading underlined the setext way.\n');
git(['add', '-A']);
git(['commit', '-qm', 'first']);
git(['branch', 'base']);

check('a clean branch has nothing to say', () => {
  write('good.js', 'export const a = 2;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'second']);
  assert.deepEqual(inspectBranch(repo, { base: 'base' }), []);
});

check('a committed conflict marker is found — in the blob, with the tree clean', () => {
  write('bad.js', '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> other\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'the bad one']);
  // The exact shape of bc-d2y6: the file is repaired afterwards, so `git status` is
  // empty and every working-tree check passes over a branch that is still broken.
  write('bad.js', 'const a = 2;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixed, but the history is not']);
  assert.equal(git(['status', '--porcelain']), '', 'the tree must be clean for this to mean anything');

  const found = inspectBranch(repo, { base: 'base' });
  assert.equal(found.length, 0, 'the branch tip is fine — nothing to report');

  const inCommit = inspectCommit(repo, 'HEAD~1');
  assert.equal(inCommit.length, 1);
  assert.equal(inCommit[0].file, 'bad.js');
  assert.equal(inCommit[0].kind, 'conflict');
  assert.equal(inCommit[0].markers.length, 2, '`=======` is not counted');
});

check('a marker at the branch tip is what stops a delivery', () => {
  write('tip.js', 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n>>>>>>> other\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'still conflicted']);
  const found = inspectBranch(repo, { base: 'base' });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].file, 'tip.js');
  assert.equal(found[0].kind, 'conflict');
  git(['reset', '-q', '--hard', 'HEAD~1']);
});

check('a syntax error with no markers is reported as one', () => {
  write('broken.js', 'const a = ;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'unparseable']);
  const found = inspectBranch(repo, { base: 'base' });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].kind, 'syntax');
  assert.match(found[0].error, /SyntaxError/);
  git(['reset', '-q', '--hard', 'HEAD~1']);
});

check('a conflicted .js is reported once, as a conflict rather than as a parse error', () => {
  write('both.js', '<<<<<<< HEAD\nconst a = 1;\n>>>>>>> other\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'both at once']);
  const found = inspectBranch(repo, { base: 'base' });
  assert.equal(found.length, 1, 'one finding, not two');
  assert.equal(found[0].kind, 'conflict');
  git(['reset', '-q', '--hard', 'HEAD~1']);
});

check('a Markdown setext heading is not a conflict', () => {
  write('README.md', 'Beadcause\n=========\n\nStill just a heading.\nAnd another\n=======\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'prose']);
  assert.deepEqual(inspectBranch(repo, { base: 'base' }), []);
});

check('a binary file is skipped rather than decoded', () => {
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0x3c, 0x3c, 0x00, 0xff]));
  git(['add', '-A']);
  git(['commit', '-qm', 'binary']);
  assert.deepEqual(inspectBranch(repo, { base: 'base' }), []);
});

check('a deleted file does not crash the scan', () => {
  git(['rm', '-q', 'blob.bin']);
  git(['commit', '-qm', 'gone']);
  assert.deepEqual(inspectBranch(repo, { base: 'base' }), []);
});

check('a non-.js file is grepped but never parsed', () => {
  write('notes.txt', 'const a = ;\nthis is prose, not javascript\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'prose that is not js']);
  assert.deepEqual(inspectBranch(repo, { base: 'base' }), []);
});

/* ------------------------------------------------------------------------- staged */

console.log('\nand of the index, which is what the hook asks');

check('the staged blob is what is read, not the file on disk', () => {
  write('staged.js', '<<<<<<< HEAD\nconst a = 1;\n>>>>>>> other\n');
  git(['add', 'staged.js']);
  // Repair the working tree *after* staging. `git commit` would still write the
  // conflicted blob, and every check that reads the file on disk would say it is fine.
  write('staged.js', 'const a = 1;\n');
  const found = inspectStaged(repo);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].file, 'staged.js');
  assert.equal(found[0].kind, 'conflict');
  git(['reset', '-q', 'HEAD']);
  fs.rmSync(path.join(repo, 'staged.js'));
});

check('nothing staged is nothing to say', () => {
  assert.deepEqual(inspectStaged(repo), []);
});

check('the first commit of an unborn repo does not crash it', () => {
  const fresh = path.join(tmp, 'fresh');
  fs.mkdirSync(fresh);
  git(['init', '-q', '-b', 'main', fresh], tmp);
  fs.writeFileSync(path.join(fresh, 'a.js'), '<<<<<<< HEAD\nconst a = 1;\n>>>>>>> b\n');
  git(['add', '-A'], fresh);
  const found = inspectStaged(fresh);
  assert.equal(found.length, 1, 'HEAD does not resolve yet, and the check still works');
});

/* ------------------------------------------------------------------------- report */

console.log('\nwhat it says when it refuses');

check('the report names the file, the line, and the marker', () => {
  const text = report([{ file: 'public/console.js', kind: 'conflict', markers: [{ line: 12, text: '<<<<<<< HEAD' }] }]);
  assert.match(text, /public\/console\.js/);
  assert.match(text, /12: <<<<<<< HEAD/);
});

check('and says to amend the commit, because the working tree is not the problem', () => {
  const text = report([{ file: 'a.js', kind: 'conflict', markers: [{ line: 1, text: '<<<<<<< HEAD' }] }]);
  assert.match(text, /Resolve the file/);
  assert.match(text, /working tree/);
});

/* ---------------------------------------------------------------------- the script */

console.log('\nthe command itself');

const run = (args, cwd) => {
  const res = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'conflict-check.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return res;
};
const runCode = (args, cwd) => {
  try {
    run(args, cwd);
    return { code: 0, out: '' };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
};

check('exits 0 on a clean branch', () => {
  const res = runCode(['--base', 'base'], repo);
  assert.equal(res.code, 0, res.out);
});

check('exits 1 and says what is wrong on a conflicted one', () => {
  write('cli.js', '<<<<<<< HEAD\nconst a = 1;\n>>>>>>> other\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'for the cli']);
  const res = runCode(['--base', 'base'], repo);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /cli\.js/);
  assert.match(res.out, /conflict marker/);
  git(['reset', '-q', '--hard', 'HEAD~1']);
});

check('--install-hook writes a pre-commit hook, and the hook refuses a bad commit', () => {
  const res = runCode(['--install-hook'], repo);
  assert.equal(res.code, 0, res.out);
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hook), 'no hook written');
  assert.ok(fs.statSync(hook).mode & 0o111, 'not executable');

  write('hooked.js', '<<<<<<< HEAD\nconst a = 1;\n>>>>>>> other\n');
  git(['add', '-A']);
  let refused = false;
  try {
    git(['commit', '-qm', 'should not land']);
  } catch (err) {
    refused = true;
    assert.match(`${err.stdout || ''}${err.stderr || ''}`, /hooked\.js/);
  }
  assert.ok(refused, 'the hook let a conflicted commit through');
  // …and --no-verify still gets past it, which is deliberate and documented.
  git(['commit', '-qm', 'forced', '--no-verify']);
  git(['reset', '-q', '--hard', 'HEAD~1']);
  fs.rmSync(hook);
});

check('--install-hook refuses to clobber somebody else’s hook', () => {
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const res = runCode(['--install-hook'], repo);
  assert.equal(res.code, 1, res.out);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n', 'it overwrote a hook it did not write');
  fs.rmSync(hook);
});

check('and installing twice over its own hook is fine', () => {
  assert.equal(runCode(['--install-hook'], repo).code, 0);
  assert.equal(runCode(['--install-hook'], repo).code, 0);
  fs.rmSync(path.join(repo, '.git', 'hooks', 'pre-commit'));
});

check('a core.hooksPath outside the git directory is refused, not silently obeyed — bc-y3qk.13', () => {
  const stray = path.join(tmp, 'stray-hooks');
  git(['config', '--local', 'core.hooksPath', stray]);
  const res = runCode(['--install-hook'], repo);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /core\.hooksPath/);
  assert.match(res.out, /outside/);
  assert.ok(!fs.existsSync(stray), 'wrote into the stray directory instead of refusing');
  git(['config', '--local', '--unset', 'core.hooksPath']);
});

// --------------------------------------------------------------------------------
// bc-xl7n.125 — `--install-hook` run from a *worktree* must not bake in that
// worktree's own path. `repo` above is never a worktree of anything, so it cannot
// tell the two apart; this builds a real main-checkout/worktree pair instead.

check('--install-hook run from a worktree points the hook at the main checkout, and it survives the worktree being deleted — bc-xl7n.125', () => {
  const main = path.join(tmp, 'retire-main');
  git(['init', '-q', '-b', 'main', main], tmp);
  // A stand-in for the real scripts/conflict-check.mjs: it only has to prove which
  // copy the hook actually ran, not re-implement the conflict check (that is
  // everything above this check). It approves every commit and leaves a mark.
  fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(main, 'scripts', 'conflict-check.mjs'),
    `import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n` +
      `fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ran.txt'), String(Date.now()));\n` +
      `process.exit(0);\n`,
  );
  fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'seed'], main);

  const wt = path.join(tmp, 'retire-worktree');
  git(['worktree', 'add', '-q', '-b', 'retire-wt-branch', wt], main);

  const res = runCode(['--install-hook'], wt);
  assert.equal(res.code, 0, res.out);

  const hookFile = path.join(main, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookFile), 'no hook written into the common git dir');
  const body = fs.readFileSync(hookFile, 'utf8');
  const mainScript = path.join(main, 'scripts', 'conflict-check.mjs');
  const worktreeScript = path.join(wt, 'scripts', 'conflict-check.mjs');
  assert.ok(body.includes(mainScript), `hook does not point at the main checkout's script:\n${body}`);
  assert.ok(!body.includes(worktreeScript), `hook baked in the installing worktree's own path:\n${body}`);

  // Delete the worktree that ran the install — the whole point of the bead.
  git(['worktree', 'remove', '--force', wt], main);
  assert.ok(!fs.existsSync(wt), 'worktree removal did not actually remove it');

  const ranMarker = path.join(main, 'scripts', 'ran.txt');
  assert.ok(!fs.existsSync(ranMarker), 'stub already ran before the real assertion');
  fs.writeFileSync(path.join(main, 'later.txt'), 'later\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'after the worktree is gone'], main); // throws (MODULE_NOT_FOUND) if the bug is back
  assert.ok(fs.existsSync(ranMarker), 'the hook did not actually run the main checkout script');

  git(['worktree', 'prune'], main);
  fs.rmSync(hookFile);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
