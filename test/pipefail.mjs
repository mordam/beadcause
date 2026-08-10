#!/usr/bin/env node
/**
 * No shell script pipes a slow writer into a consumer that exits early, under pipefail.
 *
 *     npm test
 *     node test/pipefail.mjs
 *
 * `set -o pipefail` and `grep -q` are each unremarkable. Together they are a trap, and
 * the trap is that a *successful* match reports failure:
 *
 *     set -euo pipefail
 *     git worktree list --porcelain | grep -qx "worktree $dir"   # 141, not 0
 *
 * `grep -q` exits the instant it matches. If the writer has not finished — and
 * `git worktree list` has not, because it stats every registration as it goes — it takes
 * SIGPIPE and dies 141. pipefail then reports the pipeline as 141, so the branch that was
 * supposed to run on a match runs on a miss instead. Nothing errors, nothing is logged,
 * and the answer is simply inverted.
 *
 * It is also a *race*, which is what makes it so hard to read. The same command over the
 * same data gives a different answer depending on how far the writer got before the pipe
 * closed, so the symptom is not "always wrong" but "wrong a varying number of times".
 *
 * bc-bcdp is what this cost. The `ship` skill's attic sweep tested each retired directory
 * for a registration with exactly that construct, once per directory, and reported most
 * of a healthy 85-entry attic as unregistered strays it would never clean up — a
 * different subset each run. A bug was filed against the attic; the attic was fine.
 *
 * The fix is never to add `|| true`, which hides a real failure just as well as a fake
 * one. It is to take the pipe out: capture the writer's output first, then match against
 * what you captured.
 *
 *     if grep -qF -- "$label" <<<"$(launchctl list 2>/dev/null)"; then
 *
 * A here-string cannot SIGPIPE: the command substitution has already run to completion
 * and the whole answer is in memory before grep starts.
 *
 * ## What this checks, and what it deliberately does not
 *
 * A pipeline is flagged only when both halves are present — `pipefail` is set in the
 * file, and the pipeline's *last* stage is a consumer known to exit before its input is
 * done (`grep -q`/`-l`, `head`, `read`, `first`-style `sed NUMq`). Anything else is left
 * alone. This is a syntactic check on purpose: the alternative is running the scripts,
 * and the whole point is that running them mostly *passes*. Three of the four sites fixed
 * with this test never once reproduced on this laptop — `launchctl list` writes 481 lines
 * fast enough to finish before grep closes the pipe, every time in 20 trials. They are
 * still wrong, they are wrong on a machine with more services or a slower disk, and a
 * static check is the only thing that sees them.
 *
 * When it fails, the fix is the here-string above — or, if the writer is genuinely
 * unbounded and you want the early exit, split it: capture to a variable, or accept the
 * status of the consumer alone with an explicit `PIPESTATUS` read that says why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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

/**
 * Consumers that stop reading before their input ends.
 *
 * `grep` only counts with a flag that makes it stop — a bare `grep` reads to EOF and is
 * perfectly safe in a pipeline, which is why the pattern is matched on the flags rather
 * than on the command. `head` with no count still stops at ten lines. `sed 1q` and its
 * relatives quit on a line number. `read` takes one line and leaves the rest.
 */
const EARLY_EXIT = [
  // `[ql]` anywhere in the flag cluster, not only at its end: `-qx` and `-ql` are as
  // early-exiting as `-q`, and matching only the last letter missed the exact line in
  // the attic sweep that caused bc-bcdp (`grep -qx`).
  { re: /^grep\b[^|]*\s-[a-zA-Z]*[ql][a-zA-Z]*(\s|$)/, why: 'grep -q/-l exits at the first match' },
  { re: /^head\b/, why: 'head stops after its count' },
  { re: /^sed\b[^|]*\s\d+q\b/, why: 'sed Nq quits at line N' },
  { re: /^read\b/, why: 'read consumes one line and stops' },
];

/** Comment and string noise stripped so a pipe inside either is not read as a pipeline. */
function codeLines(text) {
  return text.split('\n').map((line, i) => ({ n: i + 1, text: line })).filter(({ text }) => {
    const t = text.trim();
    return t && !t.startsWith('#');
  });
}

/**
 * The last stage of a pipeline on this line, if there is one.
 *
 * `||` and `|&` are not pipes, and a `|` inside a case pattern (`a|b)`) is not either, so
 * both are excluded before the split. This is a line-level read: a pipeline continued
 * across a backslash or a trailing `|` is not seen, which is the safe direction — this
 * test's job is to catch the construct that keeps being written, not to parse bash.
 */
function lastStage(line) {
  if (/\)\s*$/.test(line.trim()) && /\|/.test(line) && !/\|\s*\w+.*[^)]$/.test(line.trim())) return null;
  const masked = line.replace(/\|\|/g, '\0\0').replace(/\|&/g, '\0&');
  if (!masked.includes('|')) return null;
  const stages = masked.split('|');
  if (stages.length < 2) return null;
  return stages[stages.length - 1].replace(/\0/g, '|').trim().replace(/^\s*/, '');
}

const shellScripts = [];
for (const dir of ['scripts', 'bin']) {
  const at = path.join(ROOT, dir);
  if (!fs.existsSync(at)) continue;
  for (const f of fs.readdirSync(at)) {
    if (f.endsWith('.sh')) shellScripts.push(path.join(dir, f));
  }
}

const offenders = [];
let checked = 0;

for (const rel of shellScripts) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // Only files that actually turn it on: without pipefail a SIGPIPE upstream is invisible
  // and the construct is harmless.
  if (!/^\s*set\s+-[a-zA-Z]*o?\s*.*pipefail/m.test(text) && !/set\s+-o\s+pipefail/.test(text)) continue;
  checked += 1;
  for (const { n, text: line } of codeLines(text)) {
    const stage = lastStage(line);
    if (!stage) continue;
    const hit = EARLY_EXIT.find(({ re }) => re.test(stage));
    if (hit) offenders.push(`${rel}:${n} — ${hit.why}\n          ${line.trim()}`);
  }
}

if (!shellScripts.length) bad('there are shell scripts to check', 'found none under scripts/ or bin/');
else ok(`shell scripts found (${shellScripts.length}, ${checked} with pipefail)`);

if (offenders.length) {
  bad(
    'no pipefail script pipes into an early-exit consumer',
    `${offenders.length} site${offenders.length === 1 ? '' : 's'} — a match here can report 141:\n      ${offenders.join('\n      ')}`
  );
} else {
  ok('no pipefail script pipes into an early-exit consumer');
}

// The detector itself, against a script shaped like the bug and one shaped like the fix.
// Without this a broken regex reads as a clean repo, which is the one failure this file
// could not otherwise distinguish from success.
const BROKEN = 'set -euo pipefail\ngit worktree list --porcelain | grep -qx "worktree $d"\n';
const FIXED = 'set -euo pipefail\ngrep -qxF -- "worktree $d" <<<"$(git worktree list --porcelain)"\n';
const scan = (text) =>
  codeLines(text).filter(({ text: line }) => {
    const stage = lastStage(line);
    return stage && EARLY_EXIT.some(({ re }) => re.test(stage));
  }).length;

if (scan(BROKEN) === 1) ok('the detector sees the construct bc-bcdp was caused by');
else bad('the detector sees the construct bc-bcdp was caused by', `flagged ${scan(BROKEN)} lines, expected 1`);

if (scan(FIXED) === 0) ok('the detector passes the here-string form that fixes it');
else bad('the detector passes the here-string form that fixes it', `flagged ${scan(FIXED)} lines, expected 0`);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
