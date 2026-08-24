#!/usr/bin/env node
/**
 * `b7e-fixture` (bc-dgx7.41) — a disposable git tree with a history and a suite, to
 * point some other `b7e-*` command's `--dir` at.
 *
 *     npm test
 *     node test/fixture.mjs
 *
 * The acceptance line this suite is built around: one call reproduces bc-68ou.14's
 * cp-smoke fixture (a repo with `lib/foo.js`, `test/foo.mjs`, one commit and an
 * uncommitted fix on top), a second call with the same `--name` rebuilds it clean, the
 * tree never lives anywhere but `os.tmpdir()`, its commits carry the fixture's own
 * identity rather than whatever git identity the machine running it happens to have,
 * and `--json`'s commit shas actually resolve in the tree it just printed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-fixture');

const { buildFixture, fixtureRoot } = await import(path.join(ROOT, 'lib', 'fixture.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nb7e-fixture\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-fixture-test-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

/* ------------------------------------------------------------- reproducing cp-smoke */

{
  const result = buildFixture({
    name: 'suite-cp-smoke',
    steps: [
      { type: 'file', path: 'lib/foo.js', content: 'module.exports = () => 1;\n' },
      { type: 'file', path: 'test/foo.mjs', content: "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n" },
      { type: 'commit', message: 'initial' },
      { type: 'file', path: 'lib/foo.js', content: 'module.exports = () => 2;\n' },
    ],
  });

  check(() => assert.ok(fs.existsSync(path.join(result.dir, '.git'))), 'the tree is a git repo');
  check(() => assert.equal(fs.readFileSync(path.join(result.dir, 'lib/foo.js'), 'utf8'), 'module.exports = () => 2;\n'), 'lib/foo.js holds the uncommitted fix, not the committed version');
  check(() => assert.ok(fs.existsSync(path.join(result.dir, 'test/foo.mjs'))), 'test/foo.mjs was written');
  check(() => assert.equal(result.commits.length, 1), 'exactly one commit was made');
  check(() => assert.equal(result.commits[0].message, 'initial'), "that commit's message is the one given");

  const log = git(result.dir, 'log', '--format=%H');
  check(() => assert.equal(log.trim(), result.commits[0].sha), 'git log agrees there is exactly one commit, at the sha buildFixture returned');

  const status = git(result.dir, 'status', '--porcelain');
  check(() => assert.equal(status.trim(), 'M lib/foo.js'), 'git status shows lib/foo.js modified and nothing else — the uncommitted fix, cleanly');

  const show = git(result.dir, 'show', '--stat', '--format=', 'HEAD');
  check(() => /lib\/foo\.js/.test(show) && /test\/foo\.mjs/.test(show), 'both files landed inside the one commit, not split or missing');
}

/* -------------------------------------------------------- a second call rebuilds it */

{
  buildFixture({
    name: 'suite-rebuild',
    steps: [
      { type: 'file', path: 'a.txt', content: 'first' },
      { type: 'file', path: 'lib/keep.js', content: 'x' },
      { type: 'commit', message: 'one' },
      { type: 'file', path: 'b.txt', content: 'uncommitted' },
    ],
  });
  const second = buildFixture({ name: 'suite-rebuild', steps: [{ type: 'file', path: 'only-this.txt', content: 'fresh' }] });

  check(() => assert.ok(!fs.existsSync(path.join(second.dir, 'a.txt'))), 'the first run\'s committed file is gone after a same-name rebuild');
  check(() => assert.ok(!fs.existsSync(path.join(second.dir, 'b.txt'))), 'the first run\'s uncommitted file is gone too');
  check(() => assert.ok(fs.existsSync(path.join(second.dir, 'only-this.txt'))), 'the second run\'s own file is present');
  check(() => assert.equal(second.commits.length, 0), 'the rebuilt tree has no commits of its own — nothing carried over');
}

/* -------------------------------------------------------------- --keep refuses a rebuild */

{
  buildFixture({ name: 'suite-kept', steps: [{ type: 'file', path: 'x.txt', content: '1' }], keep: true });
  check(
    () => assert.throws(() => buildFixture({ name: 'suite-kept', steps: [] }), /kept by a previous run/),
    '--keep makes a later same-name call refuse rather than silently delete it'
  );
}

/* ------------------------------------------------------------------ only under tmpdir */

{
  const result = buildFixture({ name: 'suite-tmpdir', steps: [{ type: 'file', path: 'z.txt', content: '1' }] });
  const tmp = path.resolve(os.tmpdir());
  check(() => assert.ok(path.resolve(fixtureRoot()).startsWith(tmp + path.sep)), 'fixtureRoot() lives under os.tmpdir()');
  check(() => assert.ok(path.resolve(result.dir).startsWith(tmp + path.sep)), 'the built tree lives under os.tmpdir()');
  check(() => assert.ok(path.resolve(result.remote).startsWith(tmp + path.sep)), 'the bare remote lives under os.tmpdir() too');
  check(() => assert.ok(!result.dir.startsWith(ROOT)), 'the tree is never inside this repo checkout');
}

/* ----------------------------------------------------- committer identity, not ambient */

{
  // Give this git call an *ambient* identity that disagrees with the fixture's own —
  // environment variables outrank `-c user.name` (see lib/fixture.js), so if the
  // fixture only pinned `-c`, this would leak straight into the commit.
  const before = { ...process.env };
  process.env.GIT_AUTHOR_NAME = 'ambient impostor';
  process.env.GIT_AUTHOR_EMAIL = 'ambient@example.com';
  process.env.GIT_COMMITTER_NAME = 'ambient impostor';
  process.env.GIT_COMMITTER_EMAIL = 'ambient@example.com';
  let result;
  try {
    result = buildFixture({ name: 'suite-identity', steps: [{ type: 'file', path: 'a.txt', content: '1' }, { type: 'commit', message: 'one' }] });
  } finally {
    process.env = before;
  }
  const who = git(result.dir, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>').trim().split('\n');
  check(() => assert.equal(who[0], 'b7e-fixture <b7e-fixture@localhost>'), 'the author is the fixture\'s own identity, not the ambient GIT_AUTHOR_* the parent process set');
  check(() => assert.equal(who[1], 'b7e-fixture <b7e-fixture@localhost>'), 'the committer is too');
}

/* ---------------------------------------------------------- --json shas resolve in it */

{
  const printed = run([
    '--name', 'suite-json',
    '--file', 'lib/foo.js=module.exports = () => 1;',
    '--commit', 'first',
    '--file', 'lib/bar.js=module.exports = () => 2;',
    '--commit', 'second',
    '--json',
  ]);
  check(() => assert.equal(printed.status, 0), 'the CLI exits 0');
  let parsed;
  check(() => {
    parsed = JSON.parse(printed.stdout);
  }, '--json prints one parseable object');
  check(() => assert.equal(parsed.commits.length, 2), 'both commits are in --json, in order');
  check(() => assert.equal(parsed.commits[0].message, 'first'), 'the first commit is first');
  check(() => assert.equal(parsed.commits[1].message, 'second'), 'the second commit is second');
  check(() => assert.deepEqual(parsed.branches, ['main']), 'the default branch is reported');
  check(() => assert.ok(fs.existsSync(path.join(parsed.remote, 'HEAD'))), 'the bare remote --json names actually exists and looks like a bare repo');

  for (const c of parsed.commits) {
    check(() => {
      const type = git(parsed.dir, 'cat-file', '-t', c.sha).trim();
      assert.equal(type, 'commit');
    }, `--json's sha ${c.sha.slice(0, 8)} resolves to a real commit in the tree it just printed`);
  }
}

/* ------------------------------------------------------------------- suite paths */

{
  const printed = run(['--name', 'suite-paths', '--file', 'test/one.mjs=x', '--file', 'lib/two.js=y', '--file', 'test/nested/three.mjs=z', '--json']);
  const parsed = JSON.parse(printed.stdout);
  check(() => assert.equal(parsed.suites.length, 2), 'only the test/*.mjs paths are collected as suites');
  check(() => assert.ok(parsed.suites.every((s) => s.startsWith(parsed.dir))), 'every suite path is inside the tree --json also names');
  check(() => assert.ok(parsed.suites.some((s) => s.endsWith('test/one.mjs'))), 'a top-level test/*.mjs is a suite');
  check(() => assert.ok(parsed.suites.some((s) => s.endsWith('test/nested/three.mjs'))), 'a nested test/**/*.mjs is a suite too');
  check(() => assert.ok(!parsed.suites.some((s) => s.endsWith('two.js'))), 'a lib/*.js path is not');
}

/* -------------------------------------------------------------- --file value forms */

{
  const srcFile = path.join(scratch, 'source.txt');
  fs.writeFileSync(srcFile, 'from a file\n');

  const printed = run(['--name', 'suite-filevalues', '--file', `read.txt=@${srcFile}`, '--file', 'literal.txt=hello', '--json']);
  const parsed = JSON.parse(printed.stdout);
  check(() => assert.equal(fs.readFileSync(path.join(parsed.dir, 'read.txt'), 'utf8'), 'from a file\n'), '@<path> reads the content from that file');
  check(() => assert.equal(fs.readFileSync(path.join(parsed.dir, 'literal.txt'), 'utf8'), 'hello'), 'a plain value is taken as a literal');

  const stdinPrinted = run(['--name', 'suite-filevalues-stdin', '--file', 'from-stdin.txt=-'], { input: 'piped in\n' });
  check(() => assert.equal(stdinPrinted.status, 0), 'a bare "-" reads from stdin, and the command still exits 0');
  check(() => assert.equal(fs.readFileSync(path.join(fixtureRoot(), 'suite-filevalues-stdin', 'repo', 'from-stdin.txt'), 'utf8'), 'piped in\n'), 'and the stdin content landed in the file');
}

/* ------------------------------------------------------------------------ bad input */

check(() => assert.throws(() => buildFixture({ name: '', steps: [] })), 'buildFixture refuses an empty --name');
check(() => assert.throws(() => buildFixture({ name: '../escape', steps: [] })), 'buildFixture refuses a --name that is not a slug');
check(
  () => assert.throws(() => buildFixture({ name: 'suite-escape', steps: [{ type: 'file', path: '../../escape.txt', content: 'x' }] })),
  'buildFixture refuses a --file path that escapes the tree'
);

{
  const bad1 = run(['--name', 'x', '--file', 'no-equals-sign']);
  check(() => assert.equal(bad1.status, 1), 'the CLI exits 1 on a --file with no "="');
  const bad2 = run(['--nonsense']);
  check(() => assert.equal(bad2.status, 1), 'the CLI exits 1 on an unrecognised flag');
  const bad3 = run(['--name', 'suite-kept', '--file', 'x=1']);
  check(() => assert.equal(bad3.status, 2), 'the CLI exits 2 when a previous --keep run refuses the rebuild');
}

// Only the `suite-*` fixtures this run itself created — never the whole of
// `fixtureRoot()`, which this machine's real, concurrent use of the same command also
// shares. See test/sandbox.mjs for the identical reasoning.
for (const entry of fs.existsSync(fixtureRoot()) ? fs.readdirSync(fixtureRoot()) : []) {
  if (entry.startsWith('suite-')) fs.rmSync(path.join(fixtureRoot(), entry), { recursive: true, force: true });
}
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
