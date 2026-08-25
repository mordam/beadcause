#!/usr/bin/env node
//
// b7e-triage — re-run a sweep's failures alone, serially, and say which are real
// (bc-ka5y.15.16).
//
//   npm test
//   node test/triage.mjs
//
// lib/triage.js does the log parsing, the resolution and the serial re-run; this drives
// it directly against fabricated trees, the same split test/gate.mjs and test/blame.mjs
// use for their own siblings — real suites of this repo would make testing the triage
// slower than the four hand-triages it replaces. A handful of calls through the real
// bin/b7e-triage binary cover what only the CLI does: argv parsing, --from, --json, and
// the exit code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-triage');

const triageLib = await import(path.join(ROOT, 'lib', 'triage.js'));
const { parseFailures, resolveSuite, resultLine, triageSummaryLine, exitCodeFor, triage } = triageLib;

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-triage-test-'));

/** A fresh `<tmp>/<name>/` directory holding the given files — same shape test/gate.mjs uses. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const alwaysPass = () => "process.exit(0);\n";
const alwaysFail = (msg = 'broken') => `console.log('FAIL ${msg}');\nprocess.exit(1);\n`;
/** Fails unless `<root>/public/vendor` exists — the needs-vendor fixture. */
const needsVendor = () =>
  [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "if (fs.existsSync(path.join(root, 'public', 'vendor'))) process.exit(0);",
    "console.log('FAIL vendor missing');",
    'process.exit(1);',
  ].join('\n') + '\n';
/** Appends to `logPath` each time it runs, then builds `<root>/public/vendor`. */
const fakeVendorScript = (logPath) =>
  [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, 'built\\n');`,
    "fs.mkdirSync(path.join(root, 'public', 'vendor'), { recursive: true });",
  ].join('\n') + '\n';
/** Writes a start/end timestamp either side of a sleep, for proving serial order. */
const timed = (name, logPath, sleepMs = 100) =>
  [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ name: ${JSON.stringify(name)}, at: 'start', t: Date.now() }) + '\\n');`,
    `await new Promise((r) => setTimeout(r, ${sleepMs}));`,
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ name: ${JSON.stringify(name)}, at: 'end', t: Date.now() }) + '\\n');`,
    'process.exit(0);',
  ].join('\n') + '\n';
const readLog = (logPath) =>
  fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/* ===================================================================== *
 * 1. parseFailures — the shapes four sessions actually produced
 * ===================================================================== */

console.log('\nparseFailures reads every shape a pre-b7e-gate session left behind\n');

check('the bracket shape, with a trailing duration — b7e-gate\'s own', () => {
  assert.deepEqual(parseFailures('[215/351] FAIL test/pagealias.mjs 0.3s\n'), ['test/pagealias.mjs']);
});
check('the bracket shape with no trailing duration at all', () => {
  assert.deepEqual(parseFailures('[216/351] FAIL panestage.mjs\n'), ['panestage.mjs']);
});
check('a TIMEOUT line is read the same way as a FAIL', () => {
  assert.deepEqual(parseFailures('[9/50] TIMEOUT test/slowstart.mjs\n'), ['test/slowstart.mjs']);
});
check('the grep shape — FAIL <suite> (NNms), off a grep of a hand-rolled log', () => {
  assert.deepEqual(parseFailures('FAIL test/adoptsweepreal.mjs (43888ms)\n'), ['test/adoptsweepreal.mjs']);
});
check('a bare suite name on its own line — under a ==== FAILURES ==== header', () => {
  assert.deepEqual(
    parseFailures('==== FAILURES: 2 ====\ntest/filterpills.mjs\ntest/panes.mjs\n'),
    ['test/filterpills.mjs', 'test/panes.mjs'],
  );
});
check('b7e-gate\'s own summary line names every failure', () => {
  assert.deepEqual(
    parseFailures('344/347 passed, 3 failed: test/a.mjs, test/b.mjs, scripts/test-swap.js\n'),
    ['test/a.mjs', 'test/b.mjs', 'scripts/test-swap.js'],
  );
});
check('b7e-gate\'s own --json shape, via suitesFromGateLog', () => {
  const line = JSON.stringify({ index: 1, total: 2, suite: 'test/a.mjs', status: 'FAIL' });
  assert.deepEqual(parseFailures(`${line}\n`), ['test/a.mjs']);
});
check('duplicates across shapes are deduped, first-seen order kept', () => {
  assert.deepEqual(
    parseFailures('[1/2] FAIL test/a.mjs\nFAIL test/a.mjs (10ms)\n[2/2] FAIL test/b.mjs\n'),
    ['test/a.mjs', 'test/b.mjs'],
  );
});
check('a command example mentioning FAIL is not read as a result line', () => {
  // The literal prose one of the four sessions left behind: "grep FAIL branch-gate.log".
  // FAIL is followed by a token that does not end in .mjs/.js, so it is not a suite.
  assert.deepEqual(parseFailures('grep FAIL branch-gate.log\nFAIL test/adoptsweepreal.mjs (43888ms)\n'), [
    'test/adoptsweepreal.mjs',
  ]);
});
check('empty/undefined text returns []', () => {
  assert.deepEqual(parseFailures(''), []);
  assert.deepEqual(parseFailures(undefined), []);
});
check('an "ok" line is never mistaken for a failure', () => {
  assert.deepEqual(parseFailures('[1/2] ok test/a.mjs 0.1s\n[2/2] FAIL test/b.mjs 0.1s\n'), ['test/b.mjs']);
});

/* ===================================================================== *
 * 2. resolveSuite — a bare name against a tree's real suite list
 * ===================================================================== */

console.log('\nresolveSuite turns a bare name into a real suite path, or says why not\n');

const SUITES = ['test/pagealias.mjs', 'test/panestage.mjs', 'scripts/test-swap.js'];

check('an exact path resolves to itself', () => {
  assert.deepEqual(resolveSuite('test/pagealias.mjs', SUITES), { suite: 'test/pagealias.mjs', reason: null });
});
check('a bare basename with one match resolves to the full path', () => {
  assert.deepEqual(resolveSuite('pagealias.mjs', SUITES), { suite: 'test/pagealias.mjs', reason: null });
});
check('a name with no match in this tree is unresolved, not guessed at', () => {
  const r = resolveSuite('nosuchsuite.mjs', SUITES);
  assert.equal(r.suite, null);
  assert.match(r.reason, /no suite named nosuchsuite\.mjs/);
});
check('a basename matching two suites is unresolved, and says which two', () => {
  const dup = ['test/a/foo.mjs', 'test/b/foo.mjs'];
  const r = resolveSuite('foo.mjs', dup);
  assert.equal(r.suite, null);
  assert.match(r.reason, /ambiguous/);
  assert.match(r.reason, /test\/a\/foo\.mjs/);
  assert.match(r.reason, /test\/b\/foo\.mjs/);
});

/* ===================================================================== *
 * 3. reporting — pure formatting
 * ===================================================================== */

console.log('\nreporting\n');

check('resultLine names the suite, the verdict, and the wall time', () => {
  assert.equal(resultLine({ suite: 'test/a.mjs', verdict: 'real', ms: 1234 }), 'test/a.mjs: real (1.2s)');
});
check('resultLine for an unresolved input carries the reason instead', () => {
  assert.equal(
    resultLine({ input: 'nope.mjs', verdict: 'unresolved', reason: 'no suite named nope.mjs found in this tree' }),
    'nope.mjs: unresolved — no suite named nope.mjs found in this tree',
  );
});
check('triageSummaryLine only shows the counts that are non-zero', () => {
  assert.equal(
    triageSummaryLine([{ verdict: 'real' }, { verdict: 'flake' }, { verdict: 'flake' }]),
    '1/3 real, 2 flake',
  );
  assert.equal(triageSummaryLine([{ verdict: 'flake' }]), '0/1 real, 1 flake');
  assert.equal(triageSummaryLine([{ verdict: 'real' }]), '1/1 real');
});
check('exitCodeFor is 0 only when nothing real or unresolved survived', () => {
  assert.equal(exitCodeFor([{ verdict: 'flake' }, { verdict: 'needs vendor' }]), 0);
  assert.equal(exitCodeFor([{ verdict: 'flake' }, { verdict: 'real' }]), 1);
  assert.equal(exitCodeFor([{ verdict: 'unresolved' }]), 1);
  assert.equal(exitCodeFor([]), 0);
});

/* ===================================================================== *
 * 4. triage() — the serial re-run against fabricated trees
 * ===================================================================== */

console.log('\ntriage() — a real re-run, one suite at a time\n');

await checkAsync('a genuinely broken suite comes back real, with the tail of its output', async () => {
  const dir = tree('real', { 'test/broken.mjs': alwaysFail('it never worked') });
  const [r] = await triage(dir, ['test/broken.mjs']);
  assert.equal(r.verdict, 'real');
  assert.equal(r.suite, 'test/broken.mjs');
  assert.match(r.tail, /it never worked/);
});

await checkAsync('a suite that passes on its own comes back flake', async () => {
  const dir = tree('flake', { 'test/wasfine.mjs': alwaysPass() });
  const [r] = await triage(dir, ['test/wasfine.mjs']);
  assert.equal(r.verdict, 'flake');
});

await checkAsync('a suite resolved by bare basename is reported under its real path', async () => {
  const dir = tree('barename', { 'test/wasfine.mjs': alwaysPass() });
  const [r] = await triage(dir, ['wasfine.mjs']);
  assert.equal(r.input, 'wasfine.mjs');
  assert.equal(r.suite, 'test/wasfine.mjs');
  assert.equal(r.verdict, 'flake');
});

await checkAsync('a name with no suite in this tree is unresolved, not silently dropped', async () => {
  const dir = tree('unresolved', { 'test/wasfine.mjs': alwaysPass() });
  const results = await triage(dir, ['wasfine.mjs', 'test/ghost.mjs']);
  assert.equal(results.length, 2, 'the ghost must still appear in the results, not vanish');
  assert.equal(results[1].verdict, 'unresolved');
  assert.equal(results[1].suite, null);
});

await checkAsync('a suite that only fails without public/vendor comes back needs vendor', async () => {
  const vendorLog = path.join(tmp, 'vendor-calls.log');
  const dir = tree('needsvendor', {
    'test/wantsvendor.mjs': needsVendor(),
    'scripts/vendor.js': fakeVendorScript(vendorLog),
  });
  assert.equal(fs.existsSync(path.join(dir, 'public', 'vendor')), false, 'must start without vendor built');
  const [r] = await triage(dir, ['test/wantsvendor.mjs']);
  assert.equal(r.verdict, 'needs vendor');
  assert.equal(fs.existsSync(path.join(dir, 'public', 'vendor')), true);
});

await checkAsync('scripts/vendor.js is built at most once per call, even with two suites that need it', async () => {
  const vendorLog = path.join(tmp, 'vendor-calls-2.log');
  const dir = tree('needsvendortwice', {
    'test/wantsvendor1.mjs': needsVendor(),
    'test/wantsvendor2.mjs': needsVendor(),
    'scripts/vendor.js': fakeVendorScript(vendorLog),
  });
  const results = await triage(dir, ['test/wantsvendor1.mjs', 'test/wantsvendor2.mjs']);
  assert.equal(results[0].verdict, 'needs vendor');
  assert.equal(results[1].verdict, 'flake', 'the second suite\'s first run already sees a built vendor');
  const calls = fs.readFileSync(vendorLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(calls.length, 1, `scripts/vendor.js should run exactly once, ran ${calls.length} times`);
});

await checkAsync('a suite still broken even with vendor built comes back real, not needs vendor', async () => {
  const vendorLog = path.join(tmp, 'vendor-calls-3.log');
  const dir = tree('vendorstillbroken', {
    'test/hopeless.mjs': alwaysFail('unrelated to vendor'),
    'scripts/vendor.js': fakeVendorScript(vendorLog),
  });
  const [r] = await triage(dir, ['test/hopeless.mjs']);
  assert.equal(r.verdict, 'real');
});

await checkAsync('re-runs are serial — the second never starts before the first ends', async () => {
  const logPath = path.join(tmp, 'serial.jsonl');
  const dir = tree('serial', {
    'test/one.mjs': timed('one', logPath, 150),
    'test/two.mjs': timed('two', logPath, 150),
  });
  await triage(dir, ['test/one.mjs', 'test/two.mjs']);
  const events = readLog(logPath);
  const oneEnd = events.find((e) => e.name === 'one' && e.at === 'end').t;
  const twoStart = events.find((e) => e.name === 'two' && e.at === 'start').t;
  assert.ok(twoStart >= oneEnd, `test/two.mjs started (${twoStart}) before test/one.mjs finished (${oneEnd}) — that is concurrent, not serial`);
});

await checkAsync('--timeout (an override) is honoured, and a killed suite is real not flake', async () => {
  const dir = tree('timeout', { 'test/hangs.mjs': timed('hangs', path.join(tmp, 'hangs.jsonl'), 4000) });
  const [r] = await triage(dir, ['test/hangs.mjs'], { timeoutOverrideMs: 200 });
  assert.equal(r.status, 'TIMEOUT');
  assert.equal(r.verdict, 'real');
});

await checkAsync('an empty failure list returns no results, cleanly', async () => {
  const dir = tree('emptylist', { 'test/whatever.mjs': alwaysPass() });
  assert.deepEqual(await triage(dir, []), []);
});

/* ===================================================================== *
 * 5. the CLI — argv parsing, --from, --json, exit codes
 * ===================================================================== */

console.log('\nthe CLI\n');

check('--help prints usage and exits 0 without running anything', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /b7e-triage/);
});

check('with nothing to triage it refuses with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /nothing to triage/);
});

check('an unreadable --from is refused with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--from', path.join(tmp, 'does-not-exist.log')], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not read/);
});

{
  const dir = tree('cli-mixed', {
    'test/broken.mjs': alwaysFail('cli broken'),
    'test/wasfine.mjs': alwaysPass(),
  });

  check('positional suite names are triaged, and a real one exits non-zero', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'test/broken.mjs', 'test/wasfine.mjs'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /test\/broken\.mjs: real/);
    assert.match(run.stdout, /test\/wasfine\.mjs: flake/);
  });

  check('a clean set of suites exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'test/wasfine.mjs'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
  });

  check('--from reads a gate-shaped log and triages every name in it', () => {
    const logPath = path.join(tmp, 'cli-from.log');
    fs.writeFileSync(logPath, '[1/2] FAIL broken.mjs 0.1s\n[2/2] ok wasfine.mjs 0.1s\n1/2 passed, 1 failed: broken.mjs\n');
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--from', logPath], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /test\/broken\.mjs: real/);
  });

  check('--json prints one parseable object per line, plus a summary', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json', 'test/broken.mjs', 'test/wasfine.mjs'], { encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected two suite records plus a summary, got ${lines.length}`);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.summary, true);
    assert.match(summary.line, /1\/2 real/);
  });

  check('a name unresolved in this tree is reported plainly, and fails the run', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'test/ghost.mjs'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /unresolved/);
  });
}

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall triage checks passed\n');
process.exit(failures ? 1 : 0);
