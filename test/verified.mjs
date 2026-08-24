#!/usr/bin/env node
//
// b7e-verified — what actually ran here and what it said, in the sentence a
// delivery's `--tests` wants (bc-36xx.27).
//
//   npm test
//   node test/verified.mjs
//
// The pure log parsers are proved directly against small fabricated strings, the
// same argument test/blame.mjs makes for its own extractors. The report-building
// half is proved against a REAL git repo — a bare "origin" plus a working clone,
// the same shape test/blame.mjs and test/b7ewatch.mjs already use for their own
// tools — because the red/green judgement it reports is `lib/blame.js`'s own
// `runBlame`, and a fake filesystem would agree with itself about a comparison that
// needs a real `origin/main` to mean anything.
//
// The headline case is bc-36xx.18's own mistake: a session attested a suite was
// "a pre-existing bug on main" from memory, when the suite was in fact green on
// main and red only in that session's own worktree. `replays bc-36xx.18's shape`
// below reconstructs that log — a suite run in its own Bash call, red — and checks
// the line this tool produces says the opposite of what that session did.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-verified');

const verified = await import(path.join(ROOT, 'lib', 'verified.js'));
const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));

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
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ================================================================ 1. parseLogText */

console.log("\nparseLogText reads every shape a gate log actually comes in\n");

check('the b7e-gate plain shape — [n/t] STATUS suite secs', () => {
  const log = ['[1/2] ok test/a.mjs 0.4s', '[2/2] FAIL test/b.mjs 1.1s'].join('\n');
  assert.deepEqual(verified.parseLogText(log), [
    { suite: 'test/a.mjs', status: 'ok' },
    { suite: 'test/b.mjs', status: 'fail' },
  ]);
});

check('TIMEOUT counts as a failure, not a third status', () => {
  const log = '[1/1] TIMEOUT test/slow.mjs 900.0s';
  assert.deepEqual(verified.parseLogText(log), [{ suite: 'test/slow.mjs', status: 'fail' }]);
});

check('the b7e-gate --json shape, summary line ignored', () => {
  const log = [
    JSON.stringify({ index: 1, total: 2, suite: 'test/a.mjs', status: 'ok' }),
    JSON.stringify({ index: 2, total: 2, suite: 'test/b.mjs', status: 'FAIL' }),
    JSON.stringify({ summary: true, total: 2, passed: 1, failed: ['test/b.mjs'] }),
  ].join('\n');
  assert.deepEqual(verified.parseLogText(log), [
    { suite: 'test/a.mjs', status: 'ok' },
    { suite: 'test/b.mjs', status: 'fail' },
  ]);
});

check('a shell transcript — $ node <suite>, verdict from a FAIL line inside its own block', () => {
  const log = [
    '$ node test/onelaw.mjs',
    '  ok   one check',
    '  ok   two checks',
    '10 checks passed',
    '$ node test/approval.mjs',
    '  ok   setup',
    '  FAIL the regression check',
    '1/2 checks passed',
  ].join('\n');
  assert.deepEqual(verified.parseLogText(log), [
    { suite: 'test/onelaw.mjs', status: 'ok' },
    { suite: 'test/approval.mjs', status: 'fail' },
  ]);
});

check('a bare "node <suite>" line with no leading $ is recognised the same way', () => {
  const log = ['node test/a.mjs', '  ok   fine'].join('\n');
  assert.deepEqual(verified.parseLogText(log), [{ suite: 'test/a.mjs', status: 'ok' }]);
});

check('a suite mentioned twice keeps its LAST verdict', () => {
  const log = ['[1/1] FAIL test/a.mjs 0.1s', '$ node test/a.mjs', '  ok   fine the second time'].join('\n');
  assert.deepEqual(verified.parseLogText(log), [{ suite: 'test/a.mjs', status: 'ok' }]);
});

check('an unrelated log names no suites at all', () => {
  assert.deepEqual(verified.parseLogText('some prose about a deploy\n'), []);
  assert.deepEqual(verified.parseLogText(''), []);
});

/* ============================================================ 2. looksLikeRunRecord */

console.log('\nlooksLikeRunRecord tells a gaterun.js record from a plain-text log\n');

check('a start line is recognised', () => {
  assert.equal(verified.looksLikeRunRecord(JSON.stringify({ type: 'start', suites: [] }) + '\n'), true);
});

check('a b7e-gate plain log line is not', () => {
  assert.equal(verified.looksLikeRunRecord('[1/1] ok test/a.mjs 0.1s\n'), false);
});

check('empty text is not', () => {
  assert.equal(verified.looksLikeRunRecord(''), false);
});

/* ================================================================ fixtures for the rest */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-verified-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A bare `origin` and a working clone `work`, `main` pushed — the shape `runBlame` needs to be real about. */
function makeRepo(name, files) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n.claude/gate-runs/\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(work, 'node_modules', 'dummy.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

const passing = () => "console.log('  ok   the one check');\nprocess.exit(0);\n";
const failing = (names) => `${names.map((n) => `console.log('  FAIL ${n}');`).join('\n')}\nprocess.exit(1);\n`;

/* ============================================================ 3. touchedFiles / uncoveredFiles */

console.log('\ntouchedFiles / uncoveredFiles — the diff-coverage half\n');

check('touchedFiles lists what a feature branch changed on top of main', () => {
  const work = makeRepo('touched', { 'lib/a.js': 'module.exports = 1;\n' });
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'lib/b.js'), 'module.exports = 2;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add b');
  assert.deepEqual(verified.touchedFiles(work, 'main'), ['lib/b.js']);
});

check('touchedFiles never throws on a bad ref — empty array instead', () => {
  const work = makeRepo('badref', { 'a.txt': 'x\n' });
  assert.deepEqual(verified.touchedFiles(work, 'no-such-ref'), []);
});

check('a file a ran suite imports is covered; one nothing mentions is not', () => {
  const work = makeRepo('coverage', {
    'test/uses-a.mjs': "require('../lib/a.js');\nconsole.log('  ok   fine');\n",
    'lib/a.js': 'module.exports = 1;\n',
    'lib/orphan.js': 'module.exports = 2;\n',
  });
  const uncovered = verified.uncoveredFiles(work, ['lib/a.js', 'lib/orphan.js'], ['test/uses-a.mjs']);
  assert.deepEqual(uncovered, ['lib/orphan.js']);
});

check('no suites at all means every file is uncovered', () => {
  assert.deepEqual(verified.uncoveredFiles('/nonexistent', ['a.js'], []), ['a.js']);
});

/* ============================================================ 4. readLogSource */

console.log('\nreadLogSource normalises a plain log and a gaterun.js record alike\n');

check('a plain-text log', () => {
  const p = path.join(tmp, 'plain.log');
  fs.writeFileSync(p, '[1/2] ok test/a.mjs 0.1s\n[2/2] FAIL test/b.mjs 0.2s\nsome tail\n');
  const src = verified.readLogSource(p);
  assert.equal(src.attempted, 2);
  assert.equal(src.passed, 1);
  assert.deepEqual(src.failed, ['test/b.mjs']);
  assert.deepEqual(src.suites.sort(), ['test/a.mjs', 'test/b.mjs']);
});

await checkAsync('a lib/gaterun.js run record, by extension and by content', async () => {
  const work = makeRepo('runrecord', { 'test/x.mjs': passing() });
  const { file } = await gaterun.startRun(work, { suites: ['test/x.mjs', 'test/y.mjs'] });
  gaterun.appendResult(file, { suite: 'test/x.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.appendResult(file, { suite: 'test/y.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.2 });

  const src = verified.readLogSource(file);
  assert.equal(src.attempted, 2);
  assert.equal(src.passed, 1);
  assert.deepEqual(src.failed, ['test/y.mjs']);
  assert.deepEqual(src.suites, ['test/x.mjs', 'test/y.mjs']);
  // makeRepo's `work` is a standalone checkout, not nested under `.claude/worktrees/`
  // — lib/gaterun.js's own worktreeSlug names that "main", the same as this repo's
  // real main checkout, regardless of the fixture's own directory name.
  assert.match(src.label, /^b7e-gate run main-/);

  // Same file, renamed off .jsonl — still recognised, by content this time.
  const renamed = path.join(tmp, 'renamed-record.txt');
  fs.copyFileSync(file, renamed);
  const src2 = verified.readLogSource(renamed);
  assert.equal(src2.attempted, 2);
});

/* ============================================================ 5. discoverLogPaths */

console.log('\ndiscoverLogPaths is best-effort, never throws\n');

await checkAsync('a plain directory with no git and no gate-runs finds nothing', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'nogit-'));
  const found = await verified.discoverLogPaths(dir);
  assert.deepEqual(found.filter((f) => !f.startsWith(fs.realpathSync(os.tmpdir()))), []);
});

await checkAsync("a worktree's own most recent gaterun.js run is found", async () => {
  const work = makeRepo('discover', { 'test/x.mjs': passing() });
  const { file } = await gaterun.startRun(work, { suites: ['test/x.mjs'] });
  gaterun.appendResult(file, { suite: 'test/x.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.1 });
  const found = await verified.discoverLogPaths(work);
  assert.ok(found.includes(file));
});

/* ============================================================ 6. buildReport */

console.log('\nbuildReport — the whole answer, end to end\n');

await checkAsync('no logs given and nothing discoverable — ok:false, no line printed', async () => {
  const work = makeRepo('empty', { 'test/x.mjs': passing() });
  const report = await verified.buildReport(work, []);
  assert.equal(report.ok, false);
  assert.match(report.reason, /no run evidenced/);
});

await checkAsync(
  "replays bc-36xx.18's shape: a suite red in its own Bash call, green on main — the line says so, not 'pre-existing'",
  async () => {
    const work = makeRepo('replay36xx18', { 'test/approval.mjs': passing() });
    // The session's own worktree broke this suite locally (a missing symlink, in the
    // real incident); origin/main was never touched and stays green.
    fs.writeFileSync(path.join(work, 'test/approval.mjs'), failing(['the regression check']));

    const logPath = path.join(tmp, 'bc-36xx18-transcript.log');
    fs.writeFileSync(
      logPath,
      ['$ node test/onelaw.mjs', '  ok   one check', '$ node test/approval.mjs', '  FAIL the regression check'].join(
        '\n'
      )
    );

    const report = await verified.buildReport(work, [logPath]);
    assert.equal(report.ok, true);
    assert.equal(report.attempted, 2);
    assert.equal(report.passed, 1);
    assert.equal(report.blamed.length, 1);
    assert.equal(report.blamed[0].verdict, 'yours');
    assert.match(report.line, /test\/approval\.mjs: green on main — yours/);
    assert.doesNotMatch(report.line, /pre-existing/);
  }
);

await checkAsync('a suite red on both sides is reported as red on main too, not new', async () => {
  const work = makeRepo('bothred', { 'test/a.mjs': failing(['old bug']) });
  const logPath = path.join(tmp, 'bothred.log');
  fs.writeFileSync(logPath, '[1/1] FAIL test/a.mjs 0.1s\n');
  const report = await verified.buildReport(work, [logPath]);
  assert.equal(report.blamed[0].verdict, 'main-red');
  assert.match(report.line, /red on main too/);
});

await checkAsync('a clean run names no reds, and the diff line names an uncovered file', async () => {
  const work = makeRepo('cleanplusdiff', {
    'test/x.mjs': "require('../lib/covered.js');\nconsole.log('  ok   fine');\n",
    'lib/covered.js': 'module.exports = 1;\n',
  });
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'lib/uncovered.js'), 'module.exports = 2;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add uncovered.js');

  const logPath = path.join(tmp, 'clean.log');
  fs.writeFileSync(logPath, '[1/1] ok test/x.mjs 0.1s\n');
  const report = await verified.buildReport(work, [logPath], { since: 'main' });
  assert.match(report.line, /no reds/);
  assert.deepEqual(report.uncovered, ['lib/uncovered.js']);
  assert.match(report.line, /lib\/uncovered\.js/);
});

await checkAsync('a directory of logs is expanded, one level, and combined', async () => {
  const work = makeRepo('dirsource', { 'test/a.mjs': passing(), 'test/b.mjs': passing() });
  const logDir = fs.mkdtempSync(path.join(tmp, 'logdir-'));
  fs.writeFileSync(path.join(logDir, 'one.log'), '[1/1] ok test/a.mjs 0.1s\n');
  fs.writeFileSync(path.join(logDir, 'two.log'), '[1/1] FAIL test/b.mjs 0.1s\n');
  fs.writeFileSync(path.join(logDir, 'ignored.txt.bak'), 'not a real log\n');
  const report = await verified.buildReport(work, [logDir]);
  assert.equal(report.attempted, 2);
  assert.equal(report.passed, 1);
});

/* =================================================================== 7. the CLI */

console.log('\nbin/b7e-verified — argv, exit codes, --json\n');

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-verified/);
});

check('nothing to discover and no log given — exit 1, nothing quotable to stdout', () => {
  const work = makeRepo('cli-empty', { 'test/x.mjs': passing() });
  const r = run(work, ['--dir', work]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /no run evidenced/);
});

check('an explicit log naming a red suite — exit 0, reports the verdict', () => {
  const work = makeRepo('cli-red', { 'test/a.mjs': failing(['old bug']) });
  const logPath = path.join(tmp, 'cli-red.log');
  fs.writeFileSync(logPath, '[1/1] FAIL test/a.mjs 0.1s\n');
  const r = run(work, ['--dir', work, logPath]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /red on main too/);
  assert.match(r.stdout, /0\/1 passed/);
});

check('--json prints one parseable object with the same line inside it', () => {
  const work = makeRepo('cli-json', { 'test/a.mjs': passing() });
  const logPath = path.join(tmp, 'cli-json.log');
  fs.writeFileSync(logPath, '[1/1] ok test/a.mjs 0.1s\n');
  const r = run(work, ['--dir', work, '--json', logPath]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.attempted, 1);
  assert.equal(typeof obj.line, 'string');
});

check('--since narrows the diff-coverage half to a different ref', () => {
  const work = makeRepo('cli-since', { 'test/x.mjs': passing() });
  git(work, 'branch', 'old-point');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.mkdirSync(path.join(work, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(work, 'lib/new.js'), 'module.exports = 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add lib/new.js');
  const logPath = path.join(tmp, 'cli-since.log');
  fs.writeFileSync(logPath, '[1/1] ok test/x.mjs 0.1s\n');
  const r = run(work, ['--dir', work, '--since', 'old-point', logPath]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /old-point\.\.\.HEAD/);
  assert.match(r.stdout, /lib\/new\.js/);
});

/* ---------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} checks passed`);
process.exit(failures ? 1 : 0);
