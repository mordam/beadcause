#!/usr/bin/env node
/**
 * Record that a bead is blocked on one in a *different* tracker.
 *
 *   beadcause-block -w beadcause -b bc-bmry.6 --on deluvia/dv-265 <<'EOF'
 *   BLOCKED ON the charter amendment landing on the dv side — dv-265.
 *   EOF
 *
 * `bd dep add` reads both ids from one `BEADS_DIR`, so a bead waiting on something in
 * another workspace's tracker has no edge it could ever draw — the block used to exist
 * only as a sentence in the description, which `bd ready` has no way to read. This
 * writes the `blocked-by:<workspace>/<id>` label instead: `Bd.ready` filters it out of
 * every queue, `openWorkSession` refuses it outright if one reaches the launcher some
 * other way, and the advocate's own sweep clears it — no card, no tap — the moment the
 * far bead closes in its own tracker. See lib/farblock.js (bc-bmry.7).
 *
 * `--on` must be workspace-qualified — `<workspace>/<id>` — checked against the
 * workspaces this beadcause install actually has. There is no bare-id form: a block
 * inside one tracker already has a real mechanism (`bd dep add`), which draws an edge
 * bd itself understands, and this marker exists only for the case that mechanism cannot
 * reach.
 *
 * The body piped in becomes a comment on the bead, because a marker that only says
 * "blocked" leaves the next reader to go find out why — and the whole reason this
 * exists is that the why lives in a tracker this one cannot query.
 *
 * Prints what it did and exits non-zero only when nothing was written at all.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { beadRow } from '../lib/park.js';
import { mark, blockLabel, parseBlockTarget } from '../lib/farblock.js';
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
const id = arg('-b', '--bead', '--id');
const on = arg('--on', '--blocked-by');
const file = arg('-f', '--file');

const ws = cfg.workspaces.find((w) => w.name === wsName);
const knownWorkspaces = cfg.workspaces.map((w) => w.name);
if (!ws || !id || !on) {
  console.error('usage: beadcause-block -w <workspace> -b <bead> --on <other-workspace>/<bead> [-f why.md]');
  console.error(`workspaces: ${knownWorkspaces.join(', ')}`);
  process.exit(1);
}

// Resolved before the bead's own row is fetched: a bad target is nothing to guess
// through, and refusing before spending a `bd show` matches `mark`'s own order.
const target = parseBlockTarget(on, knownWorkspaces);
if (target.reason) {
  console.error(`beadcause-block: ${target.reason}`);
  console.error(`workspaces: ${knownWorkspaces.join(', ')}`);
  process.exit(1);
}

const why = (file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')).trim();
if (!why) {
  console.error(
    `beadcause-block: pipe in why ${id} is blocked on ${on} — nothing was written. Nothing else can query that ` +
      `tracker, so the why is the only record this bead will ever carry of it.`
  );
  process.exit(1);
}

const byline = bylineFor(cfg);
const bd = (args) =>
  execFileSync(cfg.bdBin, [...args, '--actor', byline], {
    env: { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: byline },
    cwd: ws.dir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

// Read before any write, and a refusal rather than a guess: a typo caught here costs one
// retry — caught afterwards it is a label naming a bead nothing can ever check, holding
// this one out of every queue with no sweep that will ever clear it.
const row = beadRow(bd, id);

const result = mark(bd, id, on, { row, knownWorkspaces });
if (result.refused) {
  console.error(`beadcause-block: ${result.refused}`);
  process.exit(1);
}

if (result.alreadyMarked) {
  console.log(result.notes[0]);
  process.exit(0);
}

try {
  bd(['comment', id, `Blocked on ${on} — ${why}`]);
} catch (err) {
  console.error(
    `beadcause-block: ${id} is marked, but the comment did not land (${String(err?.message || err).split('\n')[0]}). ` +
      `Add it by hand — the marker alone does not say why.`
  );
}

console.log(`marked ${id} ${blockLabel(target.workspace, target.id)}`);
if (result.reopened) console.log(`  and set it back to open, so the sweep can check whether ${on} has closed`);
for (const note of result.notes) console.log(`  note: ${note}`);
console.log(
  `  ${id} is out of every queue by the marker — nothing will open a session on it until ${on} closes, at which ` +
    `point the advocate's own sweep clears it. No tap needed.`
);
