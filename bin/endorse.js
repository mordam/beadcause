#!/usr/bin/env node
/**
 * `beadcause-endorse` — say *yes, work on this* about beads an agent filed.
 *
 * bc-7cp1.
 *
 *     beadcause-endorse bc-1kwl.7 bc-1kwl.8      # the beads, named, one at a time
 *     beadcause-endorse -w sophab sp-abc         # a workspace this checkout is not in
 *     beadcause-endorse -n bc-1kwl.7             # say what it would do, write nothing
 *
 * An agent that finds work mid-task files the bead itself and it arrives carrying
 * `unendorsed` (lib/filing.js). That marker is the one gate in beadcause that decides
 * whether a bead may be *worked*: it is out of every advocate queue, and the launcher
 * refuses it even handed the id directly (lib/endorse.js). Taking it off is therefore
 * not a tidying-up act — it is the moment unreviewed work becomes something an
 * unattended session will be opened on, some minutes later, without anybody watching.
 *
 * Until now the only way to perform it was the `/endorse` page: a queue of fat rows and
 * four buttons, which is exactly right when the decision is being made on a phone with
 * nothing else to hand. It is the wrong instrument when the decision has already been
 * made somewhere else — Adam reading the four beads a P0 advocate filed, in the session
 * that posed them to him, and saying yes to three. The advocate could write his answer
 * onto each bead as a comment and could not act on it, because an advocate may not
 * endorse its own subtree; so the yes sat there as prose and the work waited on a tap.
 *
 * This is the other door onto the same act.
 *
 * ## Through the daemon, never by taking the label off
 *
 * `bd label remove <id> unendorsed` would work, in the sense that the bead would end up
 * endorsed. It would also be invisible: the endorsement queue is cached for a few
 * seconds (lib/endorsequeue.js) and the phones are parked on a poll, so the bead would
 * go on being drawn as held on every other device until the cache turned over, and
 * tapping it there would fail over a list that was right when it was drawn. Dropping
 * that cache and emitting the bus event is `announceVerdict`, it lives behind the route,
 * and it is what actually *takes a judged bead off every device*. So this posts to
 * `POST /api/bead/endorse` and does no `bd` write of its own.
 *
 * ## It names the beads first, and refuses whole
 *
 * The preflight is lib/endorsecli.js and the reasoning is there. In short: the failure
 * this feature is written against is a single press that moved twenty-five beads nobody
 * had listed (lib/shipbead.js), so every bead is read and named before any of them is
 * moved, and one refused bead refuses the run rather than half-applying it.
 *
 * **There is no `--all` and no filter, and there should not be one.** A list of beads
 * somebody typed is a list somebody read. A predicate that resolves to a list at 03:00
 * is the press that took the marker off twenty-five ship beads, wearing a different hat.
 *
 * ## The guard, and why it is not in this file
 *
 * bc-1f5o, answered by Adam on 2026-08-17: **Adam-invoked only, and no code refusal.**
 *
 * The rule is about **initiative, not identity**. No session may endorse on its own
 * motion — including, especially, beads it filed itself. Any session may run this on ids
 * Adam has named, and a session that filed the work is *not* disqualified from being the
 * hand that clears it: once he has read the beads and named them, the human review the
 * marker exists to force has already happened. His words were "you're the hand, not the
 * judge".
 *
 * So the guard lives in the skill's prose (`~/.claude-personal/skills/endorse/SKILL.md`)
 * and there is deliberately nothing here that enforces it. The recommendation on the bead
 * was the heavier option — a refusal when the session that filed the bead is the session
 * clearing it — and he chose the lighter one, because the signal it would key on is weak
 * (`agent-filed` does not name *which* agent) and there is no evidence yet that prose is
 * insufficient. If it turns out to be, the failure looks like a session endorsing its own
 * filings unasked, and *that* is when the refusal goes in — not before.
 *
 * `autoEndorse` (lib/spaces.js) remains the separate, per-workspace answer to a different
 * question: not "may this session endorse" but "does this workspace want the gate at all".
 */
import path from 'node:path';
import { Bd } from '../lib/bd.js';
import { workspaceFor } from '../lib/claude.js';
import { loadConfig } from '../lib/config.js';
import { endorsePlan, idsProblem, normalizeIds, readResult } from '../lib/endorsecli.js';

const argv = process.argv.slice(2);
/** Flags that swallow the token after them, so a bead id is never mistaken for a value. */
const TAKES_VALUE = new Set(['--workspace', '-w', '--dir', '--url']);

function arg(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i > -1) return argv[i + 1];
  }
  return undefined;
}
const has = (...names) => names.some((n) => argv.includes(n));

/** Every bare word — the bead ids, in the order they were typed. */
function positionals() {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('-')) {
      if (TAKES_VALUE.has(tok)) i += 1;
      continue;
    }
    out.push(tok);
  }
  return out;
}

const say = (line) => console.error(`beadcause-endorse: ${line}`);
const die = (msg, code = 1) => {
  say(msg);
  process.exit(code);
};
const first = (err) => String(err?.message || err || '').split('\n')[0];

if (has('--help', '-h')) {
  console.log(
    'usage: beadcause-endorse <bead> [<bead> ...] [-w <workspace>] [--dir <checkout>] [--dry-run]\n' +
      '                         [--url <daemon>]\n' +
      '\n' +
      'Takes the `unendorsed` marker off beads an agent filed, through the daemon, so the\n' +
      'endorsement queue on every other device drops them at the same moment. Every bead is\n' +
      'named before any is moved, and one bead it refuses refuses the whole run.\n' +
      '\n' +
      'There is deliberately no --all and no filter: the ids are typed because they are read.'
  );
  process.exit(0);
}

const cfg = loadConfig();
const dir = path.resolve(arg('--dir') || process.cwd());
const dryRun = has('--dry-run', '-n');

/* ------------------------------------------------------------------ the workspace */

/**
 * Which workspace, worked out rather than asked for.
 *
 * `workspaceFor` follows the same rule the shell's own `_bd_set_workspace` does, so this
 * agrees with the tracker a `bd` typed in this directory would write to — including from
 * a worktree, which resolves to its parent repo's workspace. `-w` still wins, for the
 * bead that is not in the tracker this checkout belongs to.
 */
const wsName = arg('--workspace', '-w') || workspaceFor(cfg, dir);
const spaces = cfg.workspaces || [];
const ws = wsName ? spaces.find((w) => w.name === wsName) : null;
if (!ws) {
  die(
    wsName
      ? `no workspace called ${wsName} — ${spaces.map((w) => w.name).join(', ')}`
      : `${dir} resolves to no workspace on this Mac — name one with -w (${spaces.map((w) => w.name).join(', ')})`
  );
}

/* --------------------------------------------------------------------- the beads */

const ids = normalizeIds(positionals());
const problem = idsProblem(ids);
if (problem) die(problem);

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

/**
 * Every named bead in one `bd` spawn.
 *
 * `bd show a b c` takes a list, which matters more here than it looks: spawn count is
 * the whole cost on this tracker (see the note on `graph` in lib/bd.js), and a bead read
 * one process at a time would make the preflight the slowest part of an endorsement. It
 * prints the rows it found and complains on stderr about the ones it did not, so a short
 * answer is the tracker naming the typos; when it finds *none* it exits non-zero, which
 * is the same fact and arrives as a throw.
 */
let rows = [];
try {
  rows = await bd.json(ws, ['show', ...ids]);
} catch (err) {
  if (!/no issues? found|not found/i.test(String(err?.message || ''))) {
    die(`could not read the ${ws.name} tracker — ${first(err)}`, 5);
  }
}

const plan = endorsePlan(rows, ids);

/* ------------------------------------------------------------- say what it will do */

for (const b of plan.post) {
  say(`will endorse ${b.id} — ${b.title || '(untitled)'}`);
  for (const note of b.notes) say(`  ↳ ${note}`);
}
for (const b of plan.already) say(`nothing to do for ${b.id} — ${b.why}${b.title ? ` (${b.title})` : ''}`);
for (const b of plan.refused) say(`REFUSED ${b.id} — ${b.why}${b.title ? ` (${b.title})` : ''}`);

if (!plan.ok) {
  die(
    `${plan.refused.length} of ${ids.length} refused, so nothing was endorsed — ` +
      'run it again naming only the beads you mean',
    3
  );
}

if (dryRun) {
  say(`--dry-run: ${plan.post.length} would be endorsed in ${ws.name}, nothing written`);
  process.exit(0);
}

if (!plan.post.length) {
  say(`nothing held among those ${ids.length === 1 ? 'ids' : `${ids.length} ids`} in ${ws.name} — nothing was written`);
  process.exit(0);
}

/* ------------------------------------------------------------------------ the post */

const base = String(arg('--url') || `http://127.0.0.1:${cfg.port || 4318}`).replace(/\/+$/, '');

let res;
try {
  res = await fetch(`${base}/api/bead/endorse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify({ workspace: ws.name, ids: plan.post.map((b) => b.id) }),
  });
} catch (err) {
  die(
    `could not reach the daemon at ${base} — ${first(err)}. It is a launchd agent ` +
      '(m4m.beadcause.plist); nothing was endorsed.',
    4
  );
}

if (res.status === 401 || res.status === 403) {
  die(`${base} rejected the token — is this the same ~/.config/beadcause the daemon is running from?`, 4);
}

let body = null;
try {
  body = await res.json();
} catch {
  /* reported below against the status */
}
if (!body || typeof body !== 'object') die(`${base} answered ${res.status} with nothing readable`, 5);
if (body.error && !Array.isArray(body.results)) die(`${base} refused it — ${body.error}`, 5);

const out = readResult(body, plan);

for (const r of out.moved) console.log(`endorsed ${r.id} — ${r.title || '(untitled)'}`);
for (const r of out.raced) {
  console.log(`already endorsed ${r.id} — ${r.title || '(untitled)'}`);
  say(`${r.id} was endorsed between the read and the write — another session or a tap got there first`);
}
for (const r of out.failed) say(`could not endorse ${r.id} — ${r.error || 'no reason given'}`);

if (out.failed.length) {
  die(
    `${out.moved.length} of ${plan.post.length} endorsed in ${ws.name}; ${out.failed.length} did not move`,
    5
  );
}

say(
  `${out.moved.length} endorsed in ${ws.name}${out.raced.length ? `, ${out.raced.length} already were` : ''} — ` +
    'the advocate queues them on its next tick'
);
