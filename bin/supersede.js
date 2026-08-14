#!/usr/bin/env node
/**
 * Mark a bead a duplicate of the one that already covers it.
 *
 *   beadcause-supersede -w beadcause -b bc-e1kv --original bc-0nea <<'EOF'
 *   Both are the same fix in lib/router.js — bc-0nea landed it as #33.
 *   EOF
 *
 * The third of a worker's three honest endings, and the one it used to hand-roll. A
 * worker that finds its bead already covered by another may not close it — that call is
 * Adam's — so it records the fact instead, and the recording is what this writes: the
 * `superseded-by:<id>` label that takes the bead out of every queue, the graph edge that
 * says which bead covered it, and the status the sweep needs it left in. When the
 * original closes, `sweepSuperseded` puts the duplicate on Adam's phone as a card whose
 * one tap is the close (lib/superseded.js has the whole design).
 *
 * It exists because those writes are three, not one, and each of them had a way of going
 * wrong that reads as success:
 *
 *   - `bd dep add <dup> <an epic>` is **refused** — bd will not let a task be blocked by
 *     an epic — so the bead got the label and no edge, and nothing said so. bc-28ef.
 *   - A worker reaches this having *claimed* its own bead, and `bd ready` returns open
 *     rows only. A marked bead left `in_progress` is invisible to the sweep forever:
 *     held, with nobody ever asked.
 *   - `bd label add <dup> human` is the tempting fourth write and is the one that
 *     permanently prevents the card, because the sweep excludes the inbox by that label.
 *     Nothing here writes it; the sweep adds it when the question is actually due.
 *
 * The body piped in becomes a comment on the duplicate, because the card sends Adam to
 * this bead and "why these are the same job" is the thing they will want and the one
 * thing no machine can reconstruct. It is not optional for that reason.
 *
 * Prints what it did, one line per write, and exits non-zero only when nothing was
 * written at all — a marked bead short of an edge is a worse record, not a failed
 * command, and a caller told the whole thing failed marks it twice.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { beadRow } from '../lib/park.js';
import { mark, supersedeLabel } from '../lib/superseded.js';
import { bylineFor } from '../lib/byline.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}

const cfg = loadConfig();
const wsName = arg('-w', '--workspace') || cfg.workspaces[0]?.name;
const dup = arg('-b', '--bead', '--id');
const original = arg('-o', '--original', '--as');
const file = arg('-f', '--file');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !dup || !original) {
  console.error('usage: beadcause-supersede -w <workspace> -b <duplicate> --original <the-bead-that-covers-it> [-f why.md]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const why = (file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')).trim();
if (!why) {
  console.error(
    `beadcause-supersede: pipe in why ${dup} and ${original} are the same job — nothing was written. ` +
      `The card sends Adam to ${dup}, and a bead that only says "duplicate" is a question they cannot answer.`
  );
  process.exit(1);
}

const byline = bylineFor(cfg);
const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: byline };
const bd = (args) =>
  execFileSync(cfg.bdBin, [...args, '--actor', byline], { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * Both reads before any write, and both are refusals rather than guesses.
 *
 * The duplicate's row carries the status and any marker it already has; the original's
 * carries the one thing that decides which edge is even legal, its type. A typo caught
 * here costs one retry — caught afterwards it is a label naming a bead that does not
 * exist, which holds the duplicate out of every queue with nothing that can ever release it.
 */
const dupRow = beadRow(bd, dup);
const originalRow = beadRow(bd, original);

// The marker goes first and the comment second, which is the opposite of the sweep's
// order and for the opposite reason. The sweep comments first because its later writes
// put a question on a phone and the record has to survive one of them failing. Here the
// first write is the only one that can still refuse the whole command, and a comment
// explaining a marker that was then refused is a comment about nothing.
const result = mark(bd, dup, original, { dupRow, originalRow });
if (result.refused) {
  console.error(`beadcause-supersede: ${result.refused}`);
  process.exit(1);
}

try {
  bd(['comment', dup, `Superseded by ${original} — ${why}`]);
} catch (err) {
  console.error(
    `beadcause-supersede: ${dup} is marked, but the comment did not land (${String(err?.message || err).split('\n')[0]}). ` +
      `Add it by hand — the card sends them here and the reason is the whole of what they read.`
  );
}

console.log(`marked ${dup} ${supersedeLabel(original)}`);
if (result.reopened) console.log(`  and set it back to open, so the close card can be raised when ${original} lands`);
if (result.edge) console.log(`  drew a ${result.edge} edge ${dup} -> ${original}`);
for (const note of result.notes) console.log(`  note: ${note}`);
if (!result.held) {
  console.log(
    `  ${dup} is held by the marker rather than by the graph — nothing will open a session on it, and the ` +
      `close card is still raised the moment ${original} closes.`
  );
}
