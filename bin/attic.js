#!/usr/bin/env node
/**
 * Sweep `.claude/worktrees-retired/` — the soft-delete attic.
 *
 *   beadcause-attic <main-checkout> [--days N] [--dry-run] [--backfill] [--quiet] [--no-pr]
 *
 * Step 7b of the `ship` skill, and repo-agnostic on purpose: beadcause and sophab share
 * the retirement convention, so they share the sweep. The gates are `expireRetired` in
 * lib/tidy.js — the same ones the daemon runs on its own tick — and lib/attic.js is what
 * a person needs around them: strays, a report, and `--backfill`. This file is the
 * argument parsing and the exit code, and nothing else.
 *
 * One gate the daemon has and this does not: "a live session's cwd is inside it". That
 * one needs beadcause's config and its session list, which a sweep run from any repo's
 * main checkout should not have to load. A lock is still honoured, and a retired
 * worktree with somebody in it is a stranger thing than a live one with somebody in it.
 *
 * **Exit 0 whenever the sweep ran**, even if it removed nothing and even if entries were
 * skipped. A ship must not fail because the attic had something unmergeable in it. Exit 2
 * is reserved for a bad invocation: no directory, not a repo, a worktree rather than the
 * main checkout, `--days` that is not a number.
 */
import { sweepAttic, describeAttic, worthSaying, DEFAULT_DAYS } from '../lib/attic.js';

const USAGE = 'usage: beadcause-attic <main-checkout> [--days N] [--dry-run] [--backfill] [--quiet] [--no-pr]';

const die = (msg) => {
  console.error(`attic: ${msg}`);
  process.exit(2);
};

let days = DEFAULT_DAYS;
let dryRun = false;
let backfill = false;
let quiet = false;
// A squash-merged branch is never an ancestor of anything, so without asking GitHub
// every delivered worktree sits in the attic forever being described as unmerged work.
// `--no-pr` is for an offline sweep, or one that must not wait on `gh`.
let prMerges = true;
let main = '';

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--days') days = argv[++i];
  else if (a.startsWith('--days=')) days = a.slice('--days='.length);
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a === '--backfill') backfill = true;
  else if (a === '--quiet' || a === '-q') quiet = true;
  else if (a === '--no-pr') prMerges = false;
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
  const result = await sweepAttic(main, { days, dryRun, backfill, prMerges });
  if (!quiet || worthSaying(result)) console.log(describeAttic(result).join('\n'));
} catch (err) {
  die(err.message.split('\n')[0]);
}
