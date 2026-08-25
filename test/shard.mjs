#!/usr/bin/env node
/**
 * `lib/shard.js` and `bin/b7e-shard` — every suite lands in exactly one CI shard.
 *
 *     npm test
 *     node test/shard.mjs
 *
 * The one property that matters (bc-xlz32.4): shard the suites N ways, run all N, union
 * the results, and you must get back exactly the list `scripts/test.mjs --list` would have
 * given you — no suite silently dropped (a hole in CI coverage nobody would see, because
 * the run still goes green) and no suite silently duplicated (wasted runner minutes, and a
 * stateful suite raced against itself would flake with no local repro). This checks that
 * property directly, for every shard count `.github/workflows/test.yml` actually asks for
 * plus a couple it does not, against both a synthetic list and the real suite list this
 * repo currently has — and separately smoke-tests `bin/b7e-shard` itself, since the pure
 * function passing proves nothing about the CLI's argv handling.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSuites, REPO_ROOT } from '../lib/gate.js';
import { shardOf } from '../lib/shard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'b7e-shard');

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

/** Union of every shard, with duplicate-count and coverage checked separately. */
const checkPartition = (label, suites, total) => {
  const shards = Array.from({ length: total }, (_, i) => shardOf(suites, i, total));
  const union = shards.flat();
  const seen = new Map();
  for (const s of union) seen.set(s, (seen.get(s) || 0) + 1);

  const dropped = suites.filter((s) => !seen.has(s));
  const duped = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  const extra = union.filter((s) => !suites.includes(s));

  if (dropped.length) bad(`${label}: total=${total} drops nothing`, `dropped: ${dropped.slice(0, 5).join(', ')}`);
  else if (duped.length) bad(`${label}: total=${total} duplicates nothing`, `duplicated: ${duped.slice(0, 5).join(', ')}`);
  else if (extra.length) bad(`${label}: total=${total} invents nothing`, `unexpected: ${extra.slice(0, 5).join(', ')}`);
  else if (union.length !== suites.length) bad(`${label}: total=${total} union is the same size as the input`, `${union.length} vs ${suites.length}`);
  else ok(`${label}: total=${total} — ${total} shards union to exactly the input (${suites.length} suites)`);
};

const synthetic = Array.from({ length: 53 }, (_, i) => `test/fake${String(i).padStart(2, '0')}.mjs`);
for (const total of [1, 2, 3, 4, 7, 53, 100]) checkPartition('synthetic list', synthetic, total);

const real = discoverSuites(REPO_ROOT);
if (!real.length) bad('discoverSuites(REPO_ROOT) finds suites to shard', 'got an empty list — is this run from the repo?');
else {
  ok(`discoverSuites(REPO_ROOT) finds suites to shard (${real.length})`);
  for (const total of [1, 4]) checkPartition('this repo\'s actual suite list', real, total);
}

/** `shardOf` refuses rather than silently misbehaving on nonsense input. */
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
if (throws(() => shardOf(['a'], 0, 0))) ok('shardOf refuses total=0');
else bad('shardOf refuses total=0', 'did not throw');
if (throws(() => shardOf(['a'], -1, 4))) ok('shardOf refuses a negative index');
else bad('shardOf refuses a negative index', 'did not throw');
if (throws(() => shardOf(['a'], 4, 4))) ok('shardOf refuses index === total');
else bad('shardOf refuses index === total', 'did not throw');
if (throws(() => shardOf(['a'], 1.5, 4))) ok('shardOf refuses a non-integer index');
else bad('shardOf refuses a non-integer index', 'did not throw');

/** `bin/b7e-shard` itself: argv parsing, and it prints what `shardOf` would. */
const runCli = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

{
  const total = 4;
  const cliUnion = [];
  for (let i = 0; i < total; i++) {
    const printed = runCli(['--index', String(i), '--total', String(total)]).split('\n').filter(Boolean);
    cliUnion.push(...printed);
  }
  const expected = shardOf(real, 0, total)
    .concat(shardOf(real, 1, total), shardOf(real, 2, total), shardOf(real, 3, total));
  if (cliUnion.length === expected.length && cliUnion.every((s, i) => s === expected[i])) {
    ok(`bin/b7e-shard prints exactly what shardOf() computes, across all ${total} shards`);
  } else {
    bad('bin/b7e-shard prints exactly what shardOf() computes', `${cliUnion.length} lines vs ${expected.length} expected`);
  }
}

try {
  execFileSync(process.execPath, [CLI, '--index', '9', '--total', '4'], { encoding: 'utf8', stdio: 'pipe' });
  bad('bin/b7e-shard refuses an out-of-range --index', 'exited 0');
} catch (e) {
  if (e.status === 2) ok('bin/b7e-shard refuses an out-of-range --index (exit 2)');
  else bad('bin/b7e-shard refuses an out-of-range --index', `exited ${e.status}, wanted 2`);
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
