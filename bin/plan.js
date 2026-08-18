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
 *       files: [lib/router.js, lib/tls.js]
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
 * a group whose pull requests span two repos, a group with no prompt, **and two groups that
 * declared the same file**. All of them are plans that *look* fine and fail at launch, an
 * hour later, in a window nobody is watching: a group spanning repos is an hour of agent in
 * the wrong checkout, and a bead in two groups is two sessions writing one file. A refusal
 * here comes back to the session that wrote it, while it still has the context to fix it,
 * which is the only moment anything can.
 *
 * The `files:` refusal (bc-42ow.3) is that same argument said forwards rather than
 * backwards. Every other conflict mechanism in this repo arbitrates a collision that
 * already exists; a plan is the one document where two windows' work is decided together,
 * so it is the one place the collision can simply not be created. Declaring nothing is
 * legal — see lib/beadfiles.js on why a missing surface must never withhold work — but two
 * groups that both declare `lib/foo.js` are a decomposition with a known conflict written
 * into it. `files:` is a list of paths or globs, and it is also what the group's beads want
 * in their own descriptions, since the dispatcher reads the bead rather than the plan.
 *
 * ## What it will only say — and why saying it was worth a bead of its own
 *
 * That refusal is opt-out, because `files:` is optional. So a plan that declared nothing was
 * indistinguishable from a plan that declared and passed: same clean summary, same exit 0. On
 * bc-y3qk the planner worked that out and used it — declaring on neither group, since a wrong
 * declaration refuses and no declaration does not — and this reasoned its way out of the only
 * check on its own work, silently.
 *
 * `surfaceNotes` (bc-zjab.1) makes the two states different without making either illegal: a
 * line per group that declared nothing, naming the check that did not run, and a line where two
 * groups' surfaces meet once the ones that declared nothing are read off their beads' own text.
 * Warnings, on the same stderr the refusals use, and the exit codes below are unchanged —
 * `files:` stays optional, because a bead whose surface is genuinely unknown this early is a
 * real state and refusing it would withhold work for a forecast.
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
import { formatPlan, PLANNED_LABEL, surfaceNotes, validatePlan } from '../lib/plan.js';
import { multiRepo, repoList } from '../lib/repos.js';
import { resolveSessionDir } from '../lib/session.js';

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

/**
 * And what the plan did not say — bc-zjab.1, `surfaceNotes` in lib/plan.js.
 *
 * Printed **before** the plan is written, so it is above the summary rather than under it.
 * That ordering is the lesson of the `reopenAbandoned` note below: a warning that scrolls past
 * beneath a clean "planned bc-x — 2 groups" is a warning nobody reads, and these are the only
 * output a plan that skipped every check will ever produce.
 *
 * Everything below is best-effort on purpose and none of it can change the exit code. The two
 * reads it wants are a disk lookup and a `bd` spawn, and a remark that could refuse a legal
 * plan because a checkout moved would be worse than the silence it replaces.
 *
 * The rows come from `bd show <id>…` rather than from `children`, which is the one place the
 * epic worker's plan for this bead was out of date with the code: `Bd.children` narrows every
 * row to id/title/status/type/priority, and a bead's file surface lives in its **description**
 * — so the guess would have been made from titles alone and would almost never have fired.
 * One extra spawn, once, in a CLI a human is watching. It takes a list of ids, so it is one
 * spawn and not one per bead, and a failure falls back to the narrow rows rather than out.
 */
const checkouts = () => {
  try {
    if (!multiRepo(cfg, ws.name)) return [{ name: null, dir: resolveSessionDir(cfg, ws) }];
    return repoList(cfg, ws.name).repos.map((r) => ({ name: r.name, dir: r.dir }));
  } catch {
    // No checkout maps to this workspace — the ordinary state of a scratch tracker. Declared
    // surfaces still compare; only the guessed half goes quiet, which is the right direction.
    return [];
  }
};

try {
  const ids = [...new Set(plan.groups.flatMap((g) => g.beads))];
  let rows = children || [];
  try {
    const full = await bd.json(ws, ['show', ...ids]);
    if (Array.isArray(full) && full.length) rows = full;
  } catch {
    // A tracker that would not answer leaves the narrow rows in place.
  }
  for (const note of surfaceNotes(plan, { beads: rows, dirs: checkouts() })) warn(note);
} catch (err) {
  warn(`could not check ${epicId}'s plan for undeclared surfaces — ${err.message.split('\n')[0]}`);
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
//
// `reopenAbandoned` rather than the hand-rolled argv this used to spell out, because that
// argv was refused on every ordinary run (bc-xl7n.85): the planner window claims the epic
// as the human, this process writes as beadcause, and bd 1.2.1 refuses a reassign by
// anyone but the holder. The warning below then scrolled past *underneath* the successful
// group summary, so a planned epic that would never dispatch read as a clean success. The
// claim being released is this window's own, which is exactly the case the flag is for.
try {
  await bd.reopenAbandoned(ws, epicId);
} catch (err) {
  warn(`could not hand ${epicId} back to the queue — ${err.message.split('\n')[0]}`);
  warn(`run \`bd update ${epicId} --status open --assignee ""\` yourself, or no group will be dispatched`);
}

const prs = plan.groups.reduce((n, g) => n + g.prs.length, 0);
console.log(`planned ${epicId} — ${plan.groups.length} ${plan.groups.length === 1 ? 'group' : 'groups'}, ${prs} pull ${prs === 1 ? 'request' : 'requests'}`);
for (const g of plan.groups) console.log(`  ${g.name}: ${g.beads.join(', ')} → ${g.prs.length} in ${g.prs[0].repo}`);
