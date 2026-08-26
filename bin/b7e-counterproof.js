#!/usr/bin/env node
/**
 * `b7e-counterproof` — prove a new check is red without the fix, and put the tree back.
 *
 *     b7e-counterproof <path>... -- <suite>...    revert <path>s to --at, run each <suite>
 *     b7e-counterproof --at <ref>                  what to revert to (default: merge-base with main)
 *     b7e-counterproof --dir <root>                "this tree" is <root>, not this repo's own root
 *     b7e-counterproof --timeout <s>               per-run seconds, overriding lib/gate.js's own default
 *     b7e-counterproof --keep-going                keep going past a suite name that will not resolve
 *     b7e-counterproof --json                       one object, machine-readable, instead of the printed report
 *
 * bc-68ou.14: three sessions (bc-fh0sz, bc-xl7n.109, bc-gdub) each wrote a regression
 * check, then had to answer "does this actually catch the bug?" by hand, differently —
 * a `git stash`, a piped stash whose echoed exit code was the pipe's rather than the
 * suite's, three rounds of `sed` on a copy. Two of those forms leave the tree wrong if
 * the run crashes between mutate and restore; one of them actually lost uncommitted
 * work that way. `lib/counterproof.js` carries the mutate/run/restore and the by-name
 * comparison; this file is the argv parsing and the printing around it, the same split
 * every other `b7e-*` command in this repo uses.
 *
 * Every suite named is run twice — once against the tree exactly as it is, once with
 * `<path>...` reverted to `--at` — and only a check that is green the first time and red
 * the second counts as *proven* by the revert; one already red both times is reported
 * separately, not as evidence. The paths are always put back afterward, including on a
 * `SIGTERM`/`SIGINT` mid-run — see `lib/counterproof.js`'s own header for why that is safe.
 *
 * Exit codes: `0` every named suite flipped at least one check; `1` ran fine but at least
 * one suite passed both ways (proves nothing) or was skipped under `--keep-going`; `2`
 * refused outright — bad usage, an unresolved suite name without `--keep-going`, a `--at`
 * that does not resolve, or the tree's `b7e-gate`/counterproof lock already held.
 */
import path from 'node:path';
import { REPO_ROOT, toRepoRel, counterprove, exitCodeFor, reportLines } from '../lib/counterproof.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f, fallback) => {
  const inline = argv.find((a) => a.startsWith(`${f}=`));
  if (inline) return inline.slice(f.length + 1);
  const at = argv.indexOf(f);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

if (has('--help') || has('-h')) {
  console.log(
    [
      'b7e-counterproof <path>... -- <suite>...   revert <path>s to --at, run each <suite>',
      'b7e-counterproof --at <ref>                what to revert to (default: merge-base with main)',
      'b7e-counterproof --dir <root>               "this tree" is <root>, not this repo\'s own root',
      'b7e-counterproof --timeout <s>              per-run seconds, overriding lib/gate.js\'s own default',
      'b7e-counterproof --keep-going               keep going past a suite name that will not resolve',
      'b7e-counterproof --json                     one object, machine-readable, instead of the printed report',
      '',
      'example: b7e-counterproof --at main lib/teardown.js -- teardown',
    ].join('\n'),
  );
  process.exit(0);
}

const DIR_GIVEN = value('--dir', null);
const ROOT = path.resolve(DIR_GIVEN || REPO_ROOT);
// Same rule `b7e-affected` already holds for its own path arguments: once `--dir` points
// this at a tree that is not the one this process is standing in, a relative path given
// on the command line means relative to *that* tree, not to the real `process.cwd()`.
const CWD_BASE = DIR_GIVEN ? ROOT : process.cwd();
const AT = value('--at', null);
const JSON_MODE = has('--json');
const KEEP_GOING = has('--keep-going');
const TIMEOUT_ARG = value('--timeout', null);
const TIMEOUT_MS = TIMEOUT_ARG == null ? null : Math.max(0, Number(TIMEOUT_ARG) || 0) * 1000;

// Every token that is not a recognized flag or a value it consumes — including a bare
// `--`, which is not one of those, so it survives into this list as the one thing that
// tells paths from suites. `b7e-triage`/`b7e-blame`'s simpler `!a.startsWith('-')` filter
// cannot be reused here for exactly that reason: it would throw the separator away too.
const VALUE_FLAGS = new Set(['--dir', '--at', '--timeout']);
const BARE_FLAGS = new Set(['--json', '--keep-going', '--help', '-h']);
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (BARE_FLAGS.has(a)) continue;
  if (VALUE_FLAGS.has(a)) {
    i += 1; // and its value, whatever it is
    continue;
  }
  if (/^--(dir|at|timeout)=/.test(a)) continue;
  positionals.push(a);
}

const sep = positionals.indexOf('--');
if (sep === -1) {
  console.error(red('give one or more paths, then --, then one or more suites'));
  console.error(dim('example: b7e-counterproof --at main lib/teardown.js -- teardown'));
  process.exit(2);
}
const rawPaths = positionals.slice(0, sep);
const rawSuites = positionals.slice(sep + 1);
if (!rawPaths.length) {
  console.error(red('no paths given to revert'));
  process.exit(2);
}
if (!rawSuites.length) {
  console.error(red('no suites given to run'));
  process.exit(2);
}

const paths = rawPaths.map((p) => toRepoRel(ROOT, CWD_BASE, p));

const result = await counterprove(ROOT, {
  at: AT,
  paths,
  suites: rawSuites,
  timeoutOverrideMs: TIMEOUT_MS,
  keepGoing: KEEP_GOING,
});

if (JSON_MODE) {
  console.log(JSON.stringify(result));
} else {
  for (const line of reportLines(result)) {
    if (line.startsWith('    FAIL')) console.log(red(line));
    else if (line.startsWith('         ')) console.log(dim(line));
    else if (/^refused —/.test(line)) console.log(red(line));
    else if (/^\d+ of \d+ flipped$/.test(line)) console.log(result.ok && result.proven ? green(line) : red(line));
    else if (/proves nothing$/.test(line)) console.log(amber(line));
    else if (/^\S.*: unresolved —/.test(line)) console.log(amber(line));
    else console.log(line);
  }
}

process.exit(exitCodeFor(result));
