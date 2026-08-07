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
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';

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

const out = bd(['create', '--title', title, '--type', 'task', '--priority', String(priority), '--label', 'human', '--description', body, '--json']);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const id = created.id || created.issue?.id;

if (blocks) bd(['dep', 'add', blocks, id]);

console.log(id);
