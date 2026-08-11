#!/usr/bin/env node
/**
 * Sweep `.claude/worktrees-retired/` — the soft-delete attic.
 *
 *   beadcause-attic <main-checkout> [--days N] [--dry-run] [--backfill] [--quiet]
 *
 * Step 7b of the `ship` skill, and repo-agnostic on purpose: beadcause and sophab share
 * the retirement convention, so they share the sweep. The gates and the reasoning are in
 * lib/attic.js — this file is the argument parsing and the exit code, and nothing else.
 *
 * **Exit 0 whenever the sweep ran**, even if it removed nothing and even if entries were
 * skipped. A ship must not fail because the attic had something unmergeable in it. Exit 2
 * is reserved for a bad invocation: no directory, not a repo, a worktree rather than the
 * main checkout, `--days` that is not a number.
 */
import { sweepAttic, describeAttic, worthSaying, DEFAULT_DAYS } from '../lib/attic.js';

const USAGE = 'usage: beadcause-attic <main-checkout> [--days N] [--dry-run] [--backfill] [--quiet]';

const die = (msg) => {
  console.error(`attic: ${msg}`);
  process.exit(2);
};

let days = DEFAULT_DAYS;
let dryRun = false;
let backfill = false;
let quiet = false;
let main = '';

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--days') days = argv[++i];
  else if (a.startsWith('--days=')) days = a.slice('--days='.length);
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a === '--backfill') backfill = true;
  else if (a === '--quiet' || a === '-q') quiet = true;
  else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith('-')) die(`unknown option: ${a}`);
  else if (main) die(`unexpected argument: ${a}`);
  else main = a;
}

if (!main) die(USAGE);
// Fractional days are allowed and useful: the only honest way to test a 2-day expiry
// without waiting two days is to ask for a smaller one against a synthetic `.note`.
days = Number(days);
if (!Number.isFinite(days) || days < 0) die(`--days must be a number, got: ${process.argv.slice(2).join(' ')}`);

try {
  const result = await sweepAttic(main, { days, dryRun, backfill });
  if (!quiet || worthSaying(result)) console.log(describeAttic(result).join('\n'));
} catch (err) {
  die(err.message.split('\n')[0]);
}
