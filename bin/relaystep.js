#!/usr/bin/env node
/**
 * Record one step of a department relay on the bead it is running against.
 *
 *   beadcause-relay -w deluvia -b dv-abc --role aria --step draft --next clio \
 *     -m "the outline, three sections, sources on every claim"
 *   beadcause-relay -w deluvia -b dv-abc --role clio --step check --next aria \
 *     --flag "two dates unsourced" -m "fact pass done, everything else holds"
 *
 * The writing end of lib/relayjournal.js, and the answer to `dv-vzg`: a relay runs
 * unattended, so the trail it leaves is the only thing that can tell a relay stalled at
 * step 2 from one quietly working step 4. The relay brief (`relayBrief` in lib/session.js)
 * tells the session to run this once per handoff, before it starts the next role.
 *
 * ## Why a command rather than a line the brief tells an agent to type
 *
 * It wrote a `bd comment` per handoff until this landed, and prose in a thread is
 * unrenderable — the epic card could count comments and not read them. Two things then made
 * a tool rather than a longer instruction:
 *
 * - **The time is the fact the card is read for.** "clio, checking, forty minutes ago" is
 *   the sentence that separates stalled from progressing, and a timestamp an agent types by
 *   hand is one that can be wrong in the only direction that matters. It is stamped here.
 * - **A role name is checkable, and a typo in one is silent.** The relay definitions this
 *   workspace has already list every role that exists, so `--role clip` is refused with the
 *   list rather than written into a trail where it reads as an agent nobody has heard of.
 *   Since bc-ogicx.7 that is the *union* of every relay's roles across every checkout the
 *   workspace has, because this command is handed no bead and no checkout and so cannot
 *   know which relay a role was meant to belong to — see `rolesAcross` in lib/relaydefs.js
 *   for why a wider list is the correct trade here and a `--relay` flag is not.
 *
 * What it deliberately does not check is the *order*: whether `check` may follow `draft` on
 * this bead is a question about the chain, and the chain is derived from the assignee, which
 * `bd update --claim` overwrote the moment the window started (see lib/relay.js). Refusing
 * on a rule it cannot actually evaluate would be worse than recording what happened.
 *
 * ## What it writes
 *
 * One appended block, and nothing else — `bd update --append-notes`, so an entry can
 * destroy neither an earlier entry nor anything else in the field. There is no read of the
 * notes first, which means two roles writing at once cannot lose each other's step; a relay
 * is one window and should never do that, but the cheapest correct thing here also happens
 * to be the safe one.
 *
 * Exit codes: 1 for usage, 3 for a step or role this workspace does not have, 4 when the
 * tracker would not take the entry. A failed write is worth a non-zero exit because the
 * session that ran this is about to move on to the next role and the trail is what says it
 * did.
 */
import fs from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { rolesAcross } from '../lib/relaydefs.js';
import { multiRepo, repoList } from '../lib/repos.js';
import { resolveSessionDir } from '../lib/session.js';
import { relayEntryBlock, relayTrail, RELAY_STEPS } from '../lib/relayjournal.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const warn = (msg) => console.error(`beadcause-relay: ${msg}`);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const id = arg('--bead', '-b', '--issue', '-i');
const role = String(arg('--role') || '').trim().toLowerCase();
const step = String(arg('--step') || '').trim().toLowerCase();
const next = String(arg('--next') || '').trim().toLowerCase();
const flag = arg('--flag') || '';

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !id || !role || !step || has('--help') || has('-h')) {
  console.error('usage: beadcause-relay -w <workspace> -b <bead> --role <role> --step <step> [--next <role>] [--flag "..."] -m "what you handed on"');
  console.error(`steps: ${RELAY_STEPS.join(', ')}`);
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

// `-m` or stdin, the way every other bin in here takes its body. A pipe is what a session
// with a sentence containing quotes will reach for, and `-m` is what one with six words
// will.
const note = arg('--message', '-m') ?? readStdin();
function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    // No stdin at all — an empty body, which the usage check below turns into a refusal.
    return '';
  }
}
if (!String(note || '').trim()) {
  warn('nothing to record — say what this role did or handed on, with -m or on stdin');
  process.exit(1);
}

if (!RELAY_STEPS.includes(step)) {
  warn(`\`${step}\` is not a relay step — one of: ${RELAY_STEPS.join(', ')}`);
  process.exit(3);
}

/**
 * Every checkout this workspace has, because a relay definition now lives in one.
 *
 * A single-repo workspace has exactly one and `resolveSessionDir` is what names it — the
 * same door every other launch goes through, so this asks the same question the advocate
 * would. A multi-repo workspace has one per approved repo that resolved, and `repoList`
 * has already said in a warning why any that did not are missing; a checkout nobody can
 * find contributes no roles, which is the safe direction here.
 *
 * `[]` rather than a throw for a workspace whose directory cannot be resolved at all: the
 * role list then falls back to `cfg`, which is what this command checked against before a
 * checkout could define anything, and refusing to write a trail entry because a directory
 * moved would be the wrong end of the stick.
 */
function checkoutsOf(cfg, ws) {
  if (multiRepo(cfg, ws.name)) return repoList(cfg, ws.name).repos.map((r) => r.dir).filter(Boolean);
  try {
    return [resolveSessionDir(cfg, ws)];
  } catch {
    return [];
  }
}

// Only where the workspace has a relay at all. An install with no `relays` entry for this
// workspace and no `.beadcause/relays.yaml` in any of its checkouts has no list to check
// against, and refusing there would make the journal unusable by anything but deluvia —
// which is a rule about roles, not about trails.
//
// **Against every relay's roles at once, and not against one relay's.** This command is
// handed a workspace, a role and a step — no bead and no checkout — so under named relays
// it cannot know which relay a `--role` was meant to belong to, and `rolesAcross` says why
// the union is the right answer rather than a weaker one. A `--relay` flag would be a
// second routing decision typed by hand at the one place that cannot verify it.
const { roles, problems } = rolesAcross(cfg, ws.name, checkoutsOf(cfg, ws));
// Said, never enforced: a refused file falls through to `cfg` and so *narrows* this list,
// and a role turned down because a file somewhere would not parse reads as a bug in this
// command rather than in that file.
for (const problem of problems) warn(problem);
if (roles.size) {
  for (const [what, who] of [
    ['--role', role],
    ['--next', next],
  ]) {
    if (!who || roles.has(who)) continue;
    warn(`${what} \`${who}\` is not a role in ${ws.name} — one of: ${[...roles].sort().join(', ')}`);
    process.exit(3);
  }
}

const block = relayEntryBlock({ role, step, next, note, flag });
if (!block) {
  warn('that entry is empty once trimmed — a blank row in a trail says less than no row');
  process.exit(1);
}

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });
try {
  await bd.appendNotes(ws, id, block);
} catch (err) {
  warn(`could not write the step onto ${id} — ${err.message.split('\n')[0]}`);
  process.exit(4);
}

// Read it back and print the whole trail, which is the cheap half of what makes this worth
// running: a session mid-relay sees what the card will show, including the steps a previous
// window left, and a hand-back it is about to write is one it can already see the shape of.
let trail = null;
try {
  trail = relayTrail(await bd.show(ws, id));
} catch {
  // A read-back that fails says nothing about the write, which already succeeded.
}
console.log(`${ws.name}/${id}: ${role} · ${step}${next ? ` → ${next}` : ''}${flag ? ` · flagged: ${String(flag).trim()}` : ''}`);
if (trail) {
  for (const e of trail.entries) {
    console.log(`  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.role.padEnd(8)} ${e.step.padEnd(8)} ${e.note}${e.flag ? `  ⚑ ${e.flag}` : ''}`);
  }
}
