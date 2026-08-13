#!/usr/bin/env node
/**
 * File an epic's plan — what an epic worker decided, written where the next tick reads it.
 *
 *   beadcause-plan -w beadcause -b bc-jk4m < plan.yaml
 *   beadcause-plan -w beadcause -b bc-jk4m -f plan.yaml
 *
 * The other end of lib/plan.js. An epic worker (the brief is `planPromptFor` in
 * lib/session.js) reads an epic and everything under it, decides which beads should exist,
 * groups them, writes a prompt for each group, and runs this. From the next tick on the
 * advocate dispatches one child-worker per group instead of doing the epic itself.
 *
 * Input is YAML on stdin or `--file`:
 *
 *   groups:
 *     - name: router-tls
 *       beads: [bc-jk4m.1, bc-jk4m.2]
 *       prs:
 *         - repo: beadcause
 *           title: Terminate TLS in the router
 *       prompt: |
 *         These two are one change: the switch is unreadable until the router owns the
 *         certificate, so do them in one branch and one pull request.
 *
 * ## What it will refuse, and why refusing is the point
 *
 * Everything in `validatePlan` — a bead that is not under this epic, a bead in two groups,
 * a group whose pull requests span two repos, a group with no prompt. All of them are
 * plans that *look* fine and fail at launch, an hour later, in a window nobody is watching:
 * a group spanning repos is an hour of agent in the wrong checkout, and a bead in two
 * groups is two sessions writing one file. A refusal here comes back to the session that
 * wrote it, while it still has the context to fix it, which is the only moment anything can.
 *
 * It also refuses a prompt containing the phrases that belong to the generated brief. The
 * group prompt is the one piece of text in any brief beadcause writes that another agent
 * authored, and it is carried as a quoted section *inside* the standard brief — never
 * instead of it. See `FORBIDDEN` in lib/plan.js.
 *
 * ## Why it hands the epic back
 *
 * The planning window claimed the epic to start, exactly as every other window claims what
 * it is working. A claimed bead is out of `bd ready`, and the advocate reads a plan off
 * **epics in its queue** — so an epic left claimed is one whose plan nothing will ever act
 * on. Handing it back is therefore not tidiness, it is the step that makes the plan live,
 * and it happens here rather than in the brief so that it cannot be the one instruction a
 * session skipped.
 *
 * Exit codes: 3 when the input names no plan, 4 when the plan is not a legal one, 5 when
 * the tracker would not take it. A plan that wrote its comment but could not label or hand
 * back the epic exits 0 with a warning, because the comment is the plan and the other two
 * are recoverable by hand.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { formatPlan, PLANNED_LABEL, validatePlan } from '../lib/plan.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const warn = (msg) => console.error(`beadcause-plan: ${msg}`);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const epicId = arg('--bead', '-b', '--epic');
const file = arg('--file', '-f');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !epicId || has('--help') || has('-h')) {
  console.error('usage: beadcause-plan -w <workspace> -b <epic> [-f plan.yaml]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
let spec;
try {
  spec = YAML.parse(raw);
} catch (err) {
  warn(`that is not valid YAML — ${err.message.split('\n')[0]}`);
  process.exit(3);
}
if (!spec || (!Array.isArray(spec) && !Array.isArray(spec.groups))) {
  warn('no groups in that input — a plan is a `groups:` list');
  process.exit(3);
}

// The same three the daemon builds it with, so a workspace on a Dolt server is reached the
// same way from a pipe as from the daemon itself.
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

const epic = await bd.show(ws, epicId);
if (!epic) {
  warn(`${ws.name} has no bead ${epicId}`);
  process.exit(4);
}
if (epic.type && epic.type !== 'epic') {
  // Not fatal: an epic is a type, and a parent bead that was never retyped is still a
  // parent bead. But a plan on a leaf is a plan nothing can dispatch, so say it out loud.
  warn(`${epicId} is a ${epic.type}, not an epic — a plan only dispatches beads that are under it`);
}

/**
 * The ids the plan is allowed to name.
 *
 * `bd children` is direct children only, which is the same reach `batchesFor` settles for
 * and for the same reason: a grandchild is a level deeper than anything here dispatches,
 * and recursing would be a `bd` call per level to police a shape nobody has filed. A plan
 * naming a grandchild is refused with "no child by that id", which is a true sentence
 * about what this can check rather than a claim the bead does not exist.
 *
 * A `bd` that will not answer means the ids cannot be checked at all — and that is a
 * refusal, not a shrug. The alternative is writing a plan that dispatches windows against
 * beads nobody confirmed are there.
 */
let children;
try {
  children = await bd.children(ws, epicId);
} catch (err) {
  warn(`could not read ${epicId}'s children, so the plan cannot be checked — ${err.message.split('\n')[0]}`);
  process.exit(5);
}

let plan;
try {
  plan = validatePlan(spec, { epic: epicId, children: children || [] });
} catch (err) {
  warn(err.message);
  process.exit(4);
}

try {
  await bd.comment(ws, epicId, formatPlan(plan));
} catch (err) {
  warn(`could not write the plan onto ${epicId} — ${err.message.split('\n')[0]}`);
  process.exit(5);
}

// The label is what makes the plan *cheap to find*: it rides in with the `bd ready` rows the
// advocate's survey already has, so an epic nobody planned costs no read at all and only a
// planned one is ever fetched. Written after the comment, so a label without a plan behind
// it is not a state this can produce — and if it somehow is, the advocate reads no plan and
// falls back to mechanical grouping, which is what the subtree got before plans existed.
try {
  await bd.addLabel(ws, epicId, PLANNED_LABEL);
} catch (err) {
  warn(`the plan is on ${epicId} but the \`${PLANNED_LABEL}\` label would not go on — ${err.message.split('\n')[0]}`);
  warn(`add it by hand (\`bd label add ${epicId} ${PLANNED_LABEL}\`) or nothing will read the plan`);
}

// And the step that makes it live. See the header: the advocate reads plans off epics in
// its queue, and a claimed epic is not in one.
try {
  await bd.run(ws, ['update', epicId, '--status', 'open', '--assignee', ''], { retries: 3 });
} catch (err) {
  warn(`could not hand ${epicId} back to the queue — ${err.message.split('\n')[0]}`);
  warn(`run \`bd update ${epicId} --status open --assignee ""\` yourself, or no group will be dispatched`);
}

const prs = plan.groups.reduce((n, g) => n + g.prs.length, 0);
console.log(`planned ${epicId} — ${plan.groups.length} ${plan.groups.length === 1 ? 'group' : 'groups'}, ${prs} pull ${prs === 1 ? 'request' : 'requests'}`);
for (const g of plan.groups) console.log(`  ${g.name}: ${g.beads.join(', ')} → ${g.prs.length} in ${g.prs[0].repo}`);
