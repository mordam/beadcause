#!/usr/bin/env node
/**
 * Tell the phone what you're doing about a question.
 *
 *   beadcause-status -w climative -i cl-abc -p researching -m "reading the Stripe docs"
 *   beadcause-status -w climative -i cl-abc -p drafting -m "comparing both fee models"
 *   beadcause-status -w climative -i cl-abc --clear
 *
 * Phases: thinking · researching · drafting · building · blocked · waiting · done
 * (anything else is accepted and shown as-is).
 *
 * Writes both: the phase becomes a `agent:<phase>` state label in beads so other
 * sessions see it, and the detail line goes to beadcause's status store so the
 * card can show "drafting · comparing both fee models · 20s ago".
 */
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { setActivity, clearActivity, PHASES } from '../lib/activity.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const id = arg('--issue', '-i');
const clear = process.argv.includes('--clear');
const phase = clear ? 'idle' : arg('--phase', '-p');
const detail = arg('--message', '-m') || '';
const actor = arg('--actor') || process.env.BEADS_ACTOR || 'agent';

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !id || (!phase && !clear)) {
  console.error('usage: beadcause-status -w <workspace> -i <issue-id> -p <phase> [-m "detail"] | --clear');
  console.error(`phases:     ${Object.keys(PHASES).join(' · ')}`);
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const key = `${ws.name}/${id}`;
if (clear) clearActivity(key);
else setActivity(key, { phase, detail, actor });

// Optionally mirror the phase into beads, for tools other than beadcause. Off by
// default — each set-state writes an event bead, and progress churns too fast for
// that to be worth keeping.
if (cfg.mirrorStateToBeads) {
  const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: actor };
  try {
    const args = ['set-state', id, `agent=${phase}`];
    if (detail) args.push('--reason', detail);
    execFileSync(cfg.bdBin, args, { env, cwd: ws.dir, stdio: 'ignore' });
  } catch (err) {
    console.error(`[status] wrote locally, but bd set-state failed: ${err.message.split('\n')[0]}`);
  }
}

console.log(clear ? `cleared ${key}` : `${key} → ${phase}${detail ? ` · ${detail}` : ''}`);
