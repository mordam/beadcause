#!/usr/bin/env node
/**
 * `npm run coverage` — the Node suite, measured instead of merely passed.
 *
 *     npm run coverage                      # every suite, then fold and publish
 *     node scripts/coverage.mjs --from 1 --to 45   # one slice, accumulating
 *     node scripts/coverage.mjs --report    # fold what is already there, run nothing
 *     node scripts/coverage.mjs --reset     # throw the raw output away and start again
 *
 * There is no coverage dependency here and there does not need to be one. Node has
 * carried V8's own coverage since 10: set `NODE_V8_COVERAGE` to a directory and every
 * process that inherits the variable drops a JSON file of what it compiled and what it
 * called. scripts/test.mjs does nothing per suite except `spawnSync` it, so the variable
 * reaches all 219 of them, and reaches the daemons they start as well — which is most of
 * the point, since a good deal of this repo is only ever executed by a child process a
 * suite spawned and then killed. `lib/coverage.js` folds the pile; this file is the
 * runner and the printer.
 *
 * ## Why it slices, and why the raw directory is not cleared by default
 *
 * A full pass is 35–60 minutes on a loaded Mac. That is past every timeout an agent
 * session has, so a command that could only be run whole would be a command nothing can
 * run. V8's output makes slicing free: each process writes its own file, so two runs
 * into the same directory accumulate rather than overwrite, and `--from/--to` is
 * therefore a real slice of one measurement and not a partial one. `--reset` is the
 * explicit "this is a new measurement", and it is separate precisely so that forgetting
 * it costs you a stale mixture only when you asked for one.
 *
 * `scripts/test-swap.js` is skipped. It drives real blue/green swaps of the live daemon
 * over ~300 requests and is the one suite the notes say to run alone; the coverage it
 * would add is the router's, which the other suites reach anyway.
 *
 * ## The exit code
 *
 * Non-zero if any suite failed — a measurement taken over a red tree is still a
 * measurement, so the report is written either way, but a run that quietly averaged in
 * eleven broken suites should not look like a clean one. This is not the gate; `npm
 * test` is the gate, and it stops at the first failure where this deliberately does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { foldCoverage, saveReport, summaryLine, REPORT_PATH } from '../lib/coverage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** Alone, always — see the header. */
const SKIP = new Set(['scripts/test-swap.js']);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};

const RAW = path.resolve(value('--raw', path.join(ROOT, '.coverage')));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

/** The commit this is a claim about, and whether the tree it measured matched it. */
function stamp() {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const head = git('rev-parse', 'HEAD');
  if (!head) return null;
  return git('status', '--porcelain') ? `${head}-dirty` : head;
}

// Clears and stops, deliberately: "start again" is two commands so that neither of them
// can be the one you did not mean. A reset that also ran would make the destructive half
// invisible inside an hour of output.
if (flag('--reset')) {
  fs.rmSync(RAW, { recursive: true, force: true });
  console.log(`cleared ${RAW}`);
  process.exit(0);
}

const suites = execFileSync(process.execPath, [path.join(ROOT, 'scripts/test.mjs'), '--list'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((s) => !SKIP.has(s));

if (flag('--list')) {
  console.log(suites.join('\n'));
  process.exit(0);
}

let failed = [];

if (!flag('--report')) {
  const from = Math.max(1, Number(value('--from', 1)) || 1);
  const to = Math.min(suites.length, Number(value('--to', suites.length)) || suites.length);
  const slice = suites.slice(from - 1, to);

  fs.mkdirSync(RAW, { recursive: true });
  console.log(dim(`${slice.length} suites (${from}..${to} of ${suites.length}) → ${RAW}`));

  for (const [i, suite] of slice.entries()) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [path.join(ROOT, suite)], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 300_000,
      env: { ...process.env, NODE_V8_COVERAGE: RAW },
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const bad = run.status !== 0 || run.signal || run.error;
    if (bad) failed.push(suite);
    const label = bad ? red('FAIL') : green('ok');
    console.log(`${dim(`[${from + i}/${suites.length}]`)} ${label} ${suite} ${dim(`${secs}s`)}`);
    if (bad) {
      const tail = String(run.stderr || run.error?.message || '').trim().split('\n').slice(-3);
      for (const line of tail) console.log(dim(`      ${line}`));
    }
  }
}

/* ------------------------------------------------------------------ fold and publish */

const report = foldCoverage(RAW, { root: ROOT, commit: stamp() });
saveReport(report);

const untested = report.files.filter((f) => !f.loaded).map((f) => f.path);
const thin = report.files
  .filter((f) => f.functions && f.functions.total >= 4 && f.uncovered.length)
  .sort((a, b) => b.uncovered.length - a.uncovered.length)
  .slice(0, 10);

console.log(`\n${summaryLine(report)}`);
console.log(dim(`from ${report.processes} processes in ${RAW}${report.unreadable ? `, ${report.unreadable} unreadable` : ''}`));
console.log(dim(`published to ${REPORT_PATH} at ${report.commit || 'an unknown commit'}`));

if (untested.length) {
  console.log(`\nnever imported by any suite (${untested.length}):`);
  for (const f of untested) console.log(`  ${f}`);
}
if (thin.length) {
  console.log('\nmost functions never called:');
  for (const f of thin) {
    console.log(`  ${f.path} ${dim(`${f.uncovered.length}/${f.functions.total}`)} — ${f.uncovered.map((u) => u.name).slice(0, 6).join(', ')}`);
  }
}
if (failed.length) {
  console.log(red(`\n${failed.length} suite(s) failed — the report above was measured over a red tree:`));
  for (const f of failed) console.log(red(`  ${f}`));
}

process.exit(failed.length ? 1 : 0);
