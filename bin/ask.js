#!/usr/bin/env node
/**
 * Ask Adam a question from an agent session.
 *
 *   beadcause-ask --workspace acme --title "Gross or net platform fee?" --file brief.md
 *   cat brief.md | beadcause-ask -w acme -t "Which auth flow?"
 *
 * Creates a bead labelled `human` whose body is the markdown you piped in —
 * decision block and all. Piping the body avoids the shell-quoting misery of
 * putting a fenced block inside --description on the command line.
 *
 * Prints the new issue id. Add `--blocks <id>` to park the work that depends on
 * the answer: it goes blocked until you answer on the phone, then shows up in
 * `bd ready` on its own.
 *
 * The parking is the fiddly half and lib/park.js holds the reason: bd will only let
 * an epic be blocked by another epic, so the bead being parked is looked up *before*
 * the question is created and the question is typed to match it. Everything about
 * that order matters — the question exists after this point, so from here on nothing
 * may exit non-zero and nothing may fail to print the id. See bc-p9vx.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { beadRow, park, questionType } from '../lib/park.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const title = arg('--title', '-t');
const file = arg('--file', '-f');
const priority = arg('--priority', '-p') ?? '1';
const blocks = arg('--blocks', '-b');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !title) {
  console.error('usage: beadcause-ask -w <workspace> -t <title> [-f brief.md] [-p 1] [-b <blocked-issue-id>]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const body = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');

const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: cfg.actor };
const bd = (args) => execFileSync(cfg.bdBin, args, { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * Everything that can still refuse the whole command happens here, before the create.
 *
 * A bead id that is not in this workspace is a typo, and a typo caught now costs the
 * session one retry; caught after the create it costs Adam a question about a bead
 * that does not exist and the session an unparked bead it thinks is parked.
 */
const target = blocks ? beadRow(bd, blocks) : null;
if (blocks && !target) {
  console.error(`beadcause-ask: no bead ${blocks} in ${ws.name} — nothing was asked. Check the id and run it again.`);
  process.exit(1);
}
const type = questionType(target?.issue_type);

const out = bd(['create', '--title', title, '--type', type, '--priority', String(priority), '--label', 'human', '--description', body, '--json']);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const id = created.id || created.issue?.id;

// The question exists from here on, so this cannot throw and cannot exit non-zero: a
// caller told the command failed over a question that is already on the phone either
// asks nothing or asks twice. `park` reports instead, in one sentence.
if (blocks) {
  const { parked, note } = park(bd, blocks, id);
  if (!parked) console.error(`beadcause-ask: ${note}`);
}

console.log(id);
