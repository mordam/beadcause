#!/usr/bin/env node
//
// b7e-grep — search this repo's own files, with the roots and exclusions already
// decided (bc-4r10.21).
//
//   npm test
//   node test/repogrep.mjs
//
// lib/repogrep.js does the walking and matching; bin/b7e-grep is the argv parsing and
// printing around it, same split test/affected.mjs already made for lib/affected.js and
// bin/b7e-affected — most of this drives fabricated trees (milliseconds, not this repo's
// own several-hundred-file source tree), with a handful of checks at the end against the
// real repo and a real worktree, because the acceptance criteria this bead was filed with
// are about *this repo's own* worktree layout, not a fabricated one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-grep');

const repogrep = await import(path.join(ROOT, 'lib', 'repogrep.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-repogrep-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files at the given repo-relative paths. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true }); // so an empty `files` still leaves a real directory
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const initGitRepo = (dir) => {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
};

/* ===================================================================== *
 * 1. collectFiles — roots, --in narrowing, and every exclusion
 * ===================================================================== */

console.log('\ncollectFiles: roots and exclusions\n');

{
  const dir = tree('roots', {
    'lib/a.js': 'x',
    'bin/tool': 'x',
    'test/x.mjs': 'x',
    'scripts/y.mjs': 'x',
    'public/app.js': 'x',
    'android/app/src/Main.kt': 'x',
    'README.md': 'x',
  });

  check('with no --in, all seven roots are searched', () => {
    assert.deepEqual(repogrep.collectFiles(dir, []), [
      'README.md',
      'android/app/src/Main.kt',
      'bin/tool',
      'lib/a.js',
      'public/app.js',
      'scripts/y.mjs',
      'test/x.mjs',
    ]);
  });

  check('--in narrows to exactly the given keys, in file-sorted order', () => {
    assert.deepEqual(repogrep.collectFiles(dir, ['lib', 'readme']), ['README.md', 'lib/a.js']);
  });

  check('a root directory that does not exist is silently absent, not an error', () => {
    const bare = tree('roots-bare', { 'lib/a.js': 'x' });
    assert.deepEqual(repogrep.collectFiles(bare, ['android']), []);
  });
}

{
  const dir = tree('exclusions', {
    'lib/a.js': 'x',
    'lib/node_modules/pkg/index.js': 'x',
    'lib/.git/HEAD': 'x',
    'public/vendor/xterm.js': 'x',
    'public/real.js': 'x',
    'public/beadcause.apk': 'x',
    'public/beadcause.apk.json': 'x',
    '.coverage/out.json': 'x', // top-level; included here to prove the name is skipped anywhere
    'lib/.coverage/out.json': 'x',
    'dist/bundle.js': 'x',
    'lib/dist/bundle.js': 'x',
    'android/.gradle/cache.bin': 'x',
    'android/build/out.class': 'x',
    'android/app/build/out.class': 'x',
    'android/.idea/workspace.xml': 'x',
    'android/app/src/Main.kt': 'x',
  });

  check('node_modules, .git, public/vendor, .coverage, dist, android build output and the APK are all skipped', () => {
    assert.deepEqual(repogrep.collectFiles(dir, []), [
      'android/app/src/Main.kt',
      'lib/a.js',
      'public/real.js',
    ]);
  });

  check('.claude/ is skipped — a session working inside one worktree never sees another\'s files', () => {
    const withClaude = tree('claude-exclusion', {
      'lib/a.js': 'needle here',
      '.claude/worktrees/sibling/lib/a.js': 'needle here too',
    });
    const files = repogrep.collectFiles(withClaude, []);
    assert.deepEqual(files, ['lib/a.js']);
    assert.ok(!files.some((f) => f.includes('.claude')));
  });
}

{
  const dir = tree('symlink', { 'lib/real.js': 'x' });
  fs.mkdirSync(path.join(dir, 'lib', 'node_modules'));
  fs.writeFileSync(path.join(dir, 'lib', 'node_modules', 'pkg.js'), 'x');
  fs.symlinkSync(path.join(dir, 'lib', 'node_modules'), path.join(dir, 'lib', 'linked'));
  check('a symlinked directory is never followed', () => {
    assert.deepEqual(repogrep.collectFiles(dir, ['lib']), ['lib/real.js']);
  });
}

/* ===================================================================== *
 * 2. search — matching, OR'd patterns, --fixed, case, binary skip
 * ===================================================================== */

console.log('\nsearch: matching\n');

{
  const dir = tree('search', {
    'lib/a.js': 'const needle = 1;\nconst other = 2;\nconst NEEDLE = 3;\n',
    'lib/b.js': 'nothing here\n',
    'lib/c.js': 'a haystack line\n',
  });

  check('a plain pattern reports line number and text, grouped by file', () => {
    const { results, total } = repogrep.search(dir, ['needle'], { keys: ['lib'] });
    assert.deepEqual(results, [{ file: 'lib/a.js', hits: [{ line: 1, text: 'const needle = 1;' }] }]);
    assert.equal(total, 1);
  });

  check('multiple patterns are OR\'d, not combined into one', () => {
    const { results } = repogrep.search(dir, ['needle', 'haystack'], { keys: ['lib'] });
    assert.deepEqual(
      results.map((r) => r.file),
      ['lib/a.js', 'lib/c.js']
    );
  });

  check('-i (ignoreCase) matches regardless of case', () => {
    const { results } = repogrep.search(dir, ['NEEDLE'], { keys: ['lib'], ignoreCase: true });
    assert.deepEqual(results[0].hits.map((h) => h.line), [1, 3]);
  });

  check('a regex pattern is a real regex by default', () => {
    const { results } = repogrep.search(dir, ['^const (needle|other)'], { keys: ['lib'] });
    assert.deepEqual(results[0].hits.map((h) => h.line), [1, 2]);
  });

  check('--fixed treats regex metacharacters as literal text', () => {
    const litDir = tree('search-fixed', { 'lib/a.js': 'a.b(c)\nfoo\n' });
    const asRegex = repogrep.search(litDir, ['a.b(c)'], { keys: ['lib'] });
    assert.equal(asRegex.total, 0, 'as a regex, "a.b(c)" is an unbalanced-looking group and matches nothing here');
    const asFixed = repogrep.search(litDir, ['a.b(c)'], { keys: ['lib'], fixed: true });
    assert.equal(asFixed.total, 1);
  });

  check('a pattern with no hits returns an empty result, not an error', () => {
    const { results, total } = repogrep.search(dir, ['nonexistentxyz'], { keys: ['lib'] });
    assert.deepEqual(results, []);
    assert.equal(total, 0);
  });

  check('an invalid regex throws a BAD_PATTERN error naming the pattern', () => {
    assert.throws(() => repogrep.search(dir, ['(unterminated'], { keys: ['lib'] }), (err) => {
      assert.equal(err.code, 'BAD_PATTERN');
      assert.match(err.message, /unterminated/);
      return true;
    });
  });

  check('a binary file (a NUL byte in its first bytes) is skipped rather than dumped as mojibake', () => {
    const binDir = tree('search-binary', {});
    fs.mkdirSync(path.join(binDir, 'public'));
    fs.writeFileSync(path.join(binDir, 'public', 'icon.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    const { results } = repogrep.search(binDir, ['needle'], { keys: ['public'] });
    assert.deepEqual(results, []);
  });
}

/* ===================================================================== *
 * 3. repoRoot — resolves the CURRENT worktree, never a fixed script location
 * ===================================================================== */

console.log('\nrepoRoot\n');

{
  const dir = tree('worktree-root', { 'lib/a.js': 'x' });
  initGitRepo(dir);
  check('resolves to the git toplevel of the given cwd', () => {
    assert.equal(repogrep.repoRoot(dir), fs.realpathSync(dir));
  });
  check('a subdirectory of that tree still resolves to the same toplevel', () => {
    assert.equal(repogrep.repoRoot(path.join(dir, 'lib')), fs.realpathSync(dir));
  });
  check('a cwd with no git repo at all falls back rather than throwing', () => {
    const bare = tree('no-git', { 'lib/a.js': 'x' });
    assert.doesNotThrow(() => repogrep.repoRoot(bare));
  });
}

/* ===================================================================== *
 * 4. acceptance: a sibling worktree can never leak in, and root vs.
 *    worktree agree on relative paths for files that exist in both
 * ===================================================================== */

console.log('\nacceptance: worktrees\n');

{
  // Two independent git repos standing in for "the repo root" and "a worktree of it" —
  // real git worktrees share history, but nothing here depends on that; what the
  // acceptance criteria are actually about is (a) collectFiles never walks into .claude/
  // and (b) the *same relative path* comes back regardless of which tree it is run
  // against, both already covered structurally above and re-asserted here end to end.
  const mainRepo = tree('main-checkout', {
    'lib/shared.js': 'const needle = 1;\n',
    '.claude/worktrees/sibling-worktree/lib/shared.js': 'const needle = 1;\n',
  });
  initGitRepo(mainRepo);

  const worktreeRepo = tree('a-worktree', { 'lib/shared.js': 'const needle = 1;\n' });
  initGitRepo(worktreeRepo);

  check('run "from the repo root": no result under .claude/, even with a sibling match there', () => {
    const { results } = repogrep.search(mainRepo, ['needle'], { keys: ['lib'] });
    assert.deepEqual(results.map((r) => r.file), ['lib/shared.js']);
  });

  check('the same pattern run against a worktree tree gives the same relative path', () => {
    const fromRoot = repogrep.search(mainRepo, ['needle'], { keys: ['lib'] });
    const fromWorktree = repogrep.search(worktreeRepo, ['needle'], { keys: ['lib'] });
    assert.deepEqual(fromRoot.results[0].file, fromWorktree.results[0].file);
    assert.deepEqual(fromRoot.results[0].hits, fromWorktree.results[0].hits);
  });
}

/* ===================================================================== *
 * 5. the CLI — argv, exit codes, output shapes
 * ===================================================================== */

console.log('\nthe CLI\n');

{
  const dir = tree('cli', {
    'lib/a.js': 'const needle = 1;\nconst other = 2;\n',
    'lib/b.js': 'const needle = 2;\n',
    'test/x.mjs': 'nothing here\n',
  });
  const run = (...args) => spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8' });

  check('a match: exit 0, grouped by file, path:line: text, a per-file count and a total', () => {
    const r = run('needle', '--in', 'lib');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /lib\/a\.js.*\(1 match\)/);
    assert.match(r.stdout, /lib\/a\.js:1: const needle = 1;/);
    assert.match(r.stdout, /lib\/b\.js.*\(1 match\)/);
    assert.match(r.stdout, /2 matches across 2 files/);
  });

  check('--files prints only matching paths, one per line', () => {
    const r = run('needle', '--in', 'lib', '--files');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.trim().split('\n'), ['lib/a.js', 'lib/b.js']);
  });

  check('--count prints a per-file count and a total, no matched lines', () => {
    const r = run('needle', '--in', 'lib', '--count');
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, 2), ['lib/a.js: 1', 'lib/b.js: 1']);
    assert.match(lines[2], /2 matches across 2 files/); // dim()-wrapped in ANSI, hence a match not deepEqual
  });

  check('no hits: exits 1 and prints nothing on stdout', () => {
    const r = run('nonexistentxyz');
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  });

  check('--in with an unknown root is refused with exit 2', () => {
    const r = run('needle', '--in', 'bogus');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown --in root: bogus/);
  });

  check('an unrecognised flag is refused with exit 2', () => {
    const r = run('needle', '--nope');
    assert.equal(r.status, 2);
  });

  check('no pattern at all is refused with exit 2 and prints usage', () => {
    const r = run();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: b7e-grep/);
  });

  check('an invalid regex is refused with exit 2, naming the pattern', () => {
    const r = run('(unterminated');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unterminated/);
  });

  check('--fixed lets a regex-shaped literal be searched for as text', () => {
    const litDir = tree('cli-fixed', {});
    fs.mkdirSync(path.join(litDir, 'lib'));
    fs.writeFileSync(path.join(litDir, 'lib', 'a.js'), 'a.b(c)\n');
    const r = spawnSync(process.execPath, [BIN, '--dir', litDir, 'a.b(c)', '--fixed'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.b\(c\)/);
  });

  check('-i matches case-insensitively', () => {
    const r = run('NEEDLE', '--in', 'lib', '-i', '--count');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /2 matches across 2 files/);
  });

  check('multiple patterns are OR\'d on the CLI too', () => {
    const r = run('needle', 'nothing', '--files');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.trim().split('\n').sort(), ['lib/a.js', 'lib/b.js', 'test/x.mjs']);
  });
}

/* ===================================================================== *
 * 6. against the real repo and a real worktree — the acceptance criteria
 *    as this repo actually is, not a fabricated stand-in
 * ===================================================================== */

console.log('\nagainst the real repo\n');

check('finds itself: bin/b7e-grep names lib/repogrep.js in real source, not just in a fixture', () => {
  const r = spawnSync(process.execPath, [BIN, 'repogrep', '--in', 'bin'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bin\/b7e-grep/);
});

check('README.md is reachable via --in readme, and only as one file, not a directory walk', () => {
  const r = spawnSync(process.execPath, [BIN, 'b7e-grep', '--in', 'readme', '--files'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'README.md');
});

check('no live sibling worktree leaks into a real run from this checkout', () => {
  // Every worktree this repo actually has lives under .claude/worktrees/ of the main
  // checkout — real siblings, not a fixture. A search from ROOT for something virtually
  // certain to exist in more than one of them (this very file's own name) must still
  // never return a path under .claude/.
  const r = spawnSync(process.execPath, [BIN, 'ROOT_KEYS', '--in', 'lib'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('.claude'), `unexpected .claude/ path in:\n${r.stdout}`);
});

/* ===================================================================== *
 * 7. glob-shaped arguments, driven through a real zsh — quoted vs. not
 * ===================================================================== */

console.log('\nzsh: quoting\n');

{
  // The bug this bead replaces (`--include=*.js` dying with "no matches found") was a
  // FLAG VALUE zsh glob-expanded before grep ever ran. b7e-grep has no such flag — `--in`
  // takes a fixed set of names, never a pattern — so an ordinary search pattern (an
  // identifier, a path, a bead id: none of them containing *, ?, [ or {) never needs
  // quoting in the first place, quoted or not. That is what this checks. A pattern that
  // itself contains a literal shell glob character is a different, unavoidable hazard —
  // zsh's own NOMATCH kills the line before any program, this one included, ever starts
  // (verified separately below) — and no CLI can quote an argument on the caller's behalf
  // after the shell has already consumed it.
  const dir = tree('zsh-quoting', { 'lib/a.js': 'const needle = 1;\n' });
  const probe = spawnSync('zsh', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.error) {
    ok('zsh checks (skipped: no zsh on PATH)');
  } else {
    const runIn = (cmd) => spawnSync('zsh', ['-c', cmd], { encoding: 'utf8', cwd: dir });

    check('an unquoted ordinary pattern gives the same answer as a quoted one', () => {
      const quoted = runIn(`node ${JSON.stringify(BIN)} 'needle' --in lib --count`);
      const unquoted = runIn(`node ${JSON.stringify(BIN)} needle --in lib --count`);
      assert.equal(quoted.status, 0);
      assert.equal(unquoted.status, 0);
      assert.equal(quoted.stdout, unquoted.stdout);
    });

    check('a literal glob character in the pattern is a shell-level hazard, not a b7e-grep one', () => {
      const unquoted = runIn(`node ${JSON.stringify(BIN)} foo*bar --in lib --count`);
      assert.notEqual(unquoted.status, 0, 'zsh kills the whole line before node ever starts — this is NOMATCH, not b7e-grep');
      assert.match(unquoted.stderr, /no matches found/);
      const quoted = runIn(`node ${JSON.stringify(BIN)} 'foo*bar' --in lib --count`);
      assert.equal(quoted.status, 1, 'quoted, it reaches b7e-grep as a real (if pointless) regex and simply finds nothing');
    });
  }
}

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall repogrep checks passed\n');
process.exit(failures ? 1 : 0);
