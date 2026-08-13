/**
 * An epic's plan — what the epic worker decided, written where the next tick can read it.
 *
 * bc-bhp9 gave one window a whole subtree and told it to choose its own phases. That is
 * one session doing N beads, and it has the ceiling every single window has: a brief no
 * bigger than a context, an hour or two before the reaper, and no way to be resumed.
 * bc-jk4m changes what an epic worker *is* — a planner and a supervisor that does little
 * or none of the work itself, and hands out the work to N child-workers instead.
 *
 * The whole of that change rests on one thing: **the plan is a document on the epic bead,
 * not state in a window.** A supervisor that held a worker slot for the life of an epic
 * would be measured in days against a `workerTimeoutMinutes` of 120, would be reaped
 * halfway through, and would forget everything if the daemon restarted — lib/advocate.js
 * says outright that a restart mid-session forgets its workers. A document on the bead is
 * none of those: the planning window writes it and exits in twenty minutes, every later
 * tick reads it, and a daemon that died between two of them loses nothing.
 *
 * ## Where it lives, and why a comment rather than a field
 *
 * A `bd` comment, carrying a fenced JSON block between two markers. Three reasons, and
 * the first is the one that decides it:
 *
 * 1. **Append-only, so there is no read-modify-write.** `bd update --notes` replaces the
 *    field, so the daemon and the planning agent writing a plan in the same minute would
 *    have one of them silently overwrite the other — and the thing overwritten would be a
 *    plan that N windows are already being dispatched against. Comments cannot lose a
 *    write, and `planFrom` simply takes the last one that parses.
 * 2. **Revisions are history.** A re-entered supervisor writes a second plan; the first is
 *    still on the bead, which is the only record of what the epic was going to be before
 *    a child-worker filed three more beads under it.
 * 3. **It renders.** The inbox, the graph and the console already draw comments, so the
 *    plan is visible to Adam wherever he already reads the bead, without a line of new UI.
 *
 * The cost is a `bd comments` call per planned epic per tick, and that is what the
 * `planned` label is for: it rides in with the `bd ready` rows the survey already has, so
 * an epic nobody has planned costs nothing at all and only a planned one is ever read.
 *
 * ## What a plan is not allowed to be
 *
 * A group's `prompt` is text written by one agent and handed to another as part of its
 * brief, which is a channel nothing else in beadcause has. Every other brief is a pure
 * function in lib/session.js, asserted line by line in test/land.mjs precisely because the
 * brief is the whole interface between this daemon and an unattended agent. So the prompt
 * is a *section injected into* that brief and never a replacement for it — the claim, the
 * endings, the marker step and the delivery command are all still generated — and
 * `validatePlan` refuses outright any prompt that tries to write the parts of the brief
 * that are not the epic worker's to write. See `FORBIDDEN`.
 *
 * Nor may a plan endorse anything. The beads an epic worker files go through bin/file.js
 * like every other agent-filed bead and arrive `unendorsed`; lib/endorse.js is two layers
 * on purpose and neither of them has an exception for a planner. Naming an unendorsed bead
 * in a group is not an error — the group simply cannot dispatch it until Adam has looked
 * at it, because it is not in `bd ready` — and that is the gate working, not a failure.
 */

/** The label an epic carries once a plan has been written for it. One string, one place. */
export const PLANNED_LABEL = 'planned';

/**
 * And the label that says a promotion bead has already been filed for this epic, so the
 * sweep files exactly one. On the bead rather than in a ledger for the reason the plan is
 * on the bead: it has to survive a daemon that was restarted between the two ticks.
 */
export const PROMOTED_LABEL = 'promoted';

/** The markers the JSON sits between, so a comment carrying prose as well is still readable. */
export const PLAN_OPEN = '<!-- beadcause:plan -->';
export const PLAN_CLOSE = '<!-- /beadcause:plan -->';

/**
 * How many groups one plan may name, and how many beads may go in one of them.
 *
 * Both bound the same failure from different sides: a group of thirty beads is a brief no
 * session can hold — which is the ceiling `maxBatchBeads` already exists for — and thirty
 * groups is thirty windows queued behind a `maxWorkers` of one, so the last of them opens
 * some time tomorrow against a plan written today. Twelve is well past any epic Adam has
 * actually filed and still small enough that a plan is a thing a person can read.
 */
export const MAX_GROUPS = 12;
export const MAX_GROUP_BEADS = 12;

/**
 * And the ceiling on the agent-authored prompt itself. Four thousand characters is roughly
 * a page and a half — more than enough to say what a group is and what it is for, and small
 * enough that it cannot crowd out the generated brief it is injected into.
 */
export const MAX_PROMPT_CHARS = 4000;

/**
 * Phrases a group prompt may not contain, because they are the brief's own and a planner
 * writing them is writing another session's ending.
 *
 * This is a refusal at write time rather than a filter at read time, deliberately. A filter
 * would silently deliver a mangled prompt and the planner would never know; a refusal comes
 * back to the agent that wrote it, in the window where it can still fix it. And it is a
 * short list on purpose: it is not a sanitiser and cannot be one — the defence that
 * actually holds is that the prompt is a *section* and never the brief.
 */
export const FORBIDDEN = [
  // The marker a worker writes to say what is still owed. A planner writing one would have
  // a child-worker report a state nobody had reached.
  'BEAD WORK DONE',
  // The delivery, which merges. What merges a child-worker's branch is the command the
  // generated brief gives it, against the bead the advocate opened it for.
  'bin/deliver.js',
  // And the endorsement gate, from the other side: no wording an epic worker invents may
  // tell a child-worker that work nobody has looked at is workable.
  'bd label remove',
];

/**
 * The one-line rule for "is this bead under that epic", read off the id.
 *
 * Deliberately a copy of `isDescendantOf` in lib/advocate.js rather than an import of it:
 * lib/advocate.js imports this file, and a cycle between the advocate and the document it
 * reads is the kind of thing that only shows up as an undefined export three files away.
 * It is one expression and bd's ids are hierarchical by construction (`bc-x.1.2`), so the
 * duplication is a line rather than a rule that can drift.
 */
const isUnder = (id, ancestor) => Boolean(id && ancestor && String(id).startsWith(`${ancestor}.`));

const clean = (s) => String(s ?? '').trim();

/**
 * Read a plan out of a comment body, or null.
 *
 * Tolerant about what surrounds the block — a plan comment carries a human-readable
 * sentence above it, and a later one may carry a note about why it was revised — and
 * strict about the block itself: unparseable JSON between the markers is null rather than a
 * throw, because a comment somebody hand-edited must not be able to stop a tick.
 */
export function parsePlan(text) {
  const body = String(text ?? '');
  const from = body.indexOf(PLAN_OPEN);
  if (from === -1) return null;
  const to = body.indexOf(PLAN_CLOSE, from);
  const inner = to === -1 ? body.slice(from + PLAN_OPEN.length) : body.slice(from + PLAN_OPEN.length, to);
  // The fence is for the reader, not for us: take whatever is between the markers and strip
  // a ```json wrapper if it is there.
  const json = inner.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim();
  if (!json) return null;
  let plan;
  try {
    plan = JSON.parse(json);
  } catch {
    return null;
  }
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.groups)) return null;
  return plan;
}

/**
 * The plan a thread carries: the **last** comment that parses as one.
 *
 * Last rather than first because a plan is revised — a supervisor re-entered because a
 * child-worker filed new work writes a second one, and the second is the plan. The first is
 * still on the bead, which is the point of writing it as a comment at all.
 *
 * `bd comments` returns oldest first (lib/discuss.js relies on the same order), and the
 * three spellings of a comment body are the tolerant read lib/landed.js already uses.
 */
export function planFrom(comments) {
  let found = null;
  for (const c of comments || []) {
    const plan = parsePlan(c?.text ?? c?.body ?? c?.comment ?? '');
    if (plan) found = plan;
  }
  return found;
}

/**
 * The plan on an epic, or null — one `bd comments` call.
 *
 * A tracker that will not answer is null, and null here means "no plan", which routes the
 * epic to `batchesFor`'s mechanical grouping. That is the right direction: a mechanical
 * grouping is worse than a considered one and much better than none, and it is what this
 * subtree got before plans existed.
 */
export async function readPlan(bd, workspace, id) {
  try {
    return planFrom(await bd.comments(workspace, id));
  } catch {
    return null;
  }
}

/** The comment body a plan is written as. */
export function formatPlan(plan) {
  const groups = plan.groups.length;
  const prs = plan.groups.reduce((n, g) => n + g.prs.length, 0);
  const repos = new Set(plan.groups.flatMap((g) => g.prs.map((p) => p.repo)));
  const where = repos.size === 1 ? `in ${[...repos][0]}` : `across ${repos.size} repos`;
  return [
    `**Plan for ${plan.epic}** — ${groups} ${groups === 1 ? 'group' : 'groups'}, ` +
      `${prs} ${prs === 1 ? 'pull request' : 'pull requests'} ${where}.`,
    '',
    ...plan.groups.map((g) => `- **${g.name}** — ${g.beads.join(', ')}`),
    '',
    PLAN_OPEN,
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    PLAN_CLOSE,
  ].join('\n');
}

/**
 * Check a plan an agent wrote, and hand back the normalised form that gets stored.
 *
 * Throws with one sentence naming what is wrong, because the caller is bin/plan.js and its
 * caller is a session that can still fix it. Everything below is a rule about what a group
 * *is*, and the two that matter most are the last two:
 *
 * - **A group is one window, and one window is one checkout.** Since bc-l853.4 a bead names
 *   its repo and `resolveSessionRepo` opens exactly one; a group spanning two repos is a
 *   plan that cannot be carried out, and finding that at launch means an hour of agent in
 *   the wrong tree. So it is refused here, where the planner can split the group instead.
 * - **A prompt may not write the brief.** See `FORBIDDEN`.
 *
 * `children` is what the epic really has under it — the ids the plan is allowed to name.
 * Passing it is what stops a plan naming a bead in another epic, or one that does not exist,
 * which would otherwise be a group that never dispatches and never says why.
 */
export function validatePlan(raw, { epic, children = null } = {}) {
  const epicId = clean(epic);
  if (!epicId) throw new Error('a plan has to say which epic it is for');
  if (!raw || typeof raw !== 'object') throw new Error('that is not a plan — expected a mapping with a `groups:` list');
  const list = Array.isArray(raw) ? raw : raw.groups;
  if (!Array.isArray(list) || !list.length) throw new Error('a plan needs at least one group under `groups:`');
  if (list.length > MAX_GROUPS) {
    throw new Error(`${list.length} groups is more than one plan may name (${MAX_GROUPS}) — an epic that big wants splitting`);
  }

  const known = children === null ? null : new Set(children.map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean));
  const names = new Set();
  const claimed = new Map();
  const groups = [];

  for (const [i, g] of list.entries()) {
    const where = `group ${i + 1}`;
    if (!g || typeof g !== 'object') throw new Error(`${where} is not a mapping`);
    const name = clean(g.name);
    if (!name) throw new Error(`${where} has no \`name:\` — a group is named so a brief can say which one it is`);
    if (names.has(name)) throw new Error(`two groups are both called "${name}"`);
    names.add(name);

    const beads = (Array.isArray(g.beads) ? g.beads : [g.beads]).map(clean).filter(Boolean);
    if (!beads.length) throw new Error(`"${name}" names no beads`);
    if (beads.length > MAX_GROUP_BEADS) {
      throw new Error(`"${name}" has ${beads.length} beads, more than one window is briefed on (${MAX_GROUP_BEADS})`);
    }
    for (const id of beads) {
      // The epic itself is not work — its children are, and a group naming it would claim
      // the epic and take the whole subtree out of every queue. That is the bc-3zo9 shape.
      if (id === epicId) throw new Error(`"${name}" names ${epicId} itself; a group is made of the epic's children`);
      if (!isUnder(id, epicId)) throw new Error(`"${name}" names ${id}, which is not under ${epicId}`);
      if (known && !known.has(id)) throw new Error(`"${name}" names ${id}, which ${epicId} has no child by`);
      const already = claimed.get(id);
      if (already) throw new Error(`${id} is in both "${already}" and "${name}" — a bead belongs to one group`);
      claimed.set(id, name);
    }

    const prs = (Array.isArray(g.prs) ? g.prs : g.prs ? [g.prs] : []).map((p) =>
      typeof p === 'string' ? { repo: clean(p), title: '' } : { repo: clean(p?.repo), title: clean(p?.title) }
    );
    if (!prs.length) {
      throw new Error(`"${name}" says nothing about the pull requests it will open — one \`prs:\` entry per intended PR`);
    }
    for (const p of prs) if (!p.repo) throw new Error(`a pull request in "${name}" names no repo`);
    const repos = new Set(prs.map((p) => p.repo));
    if (repos.size > 1) {
      throw new Error(
        `"${name}" opens pull requests in ${[...repos].join(' and ')} — one group is one window in one checkout, so split it`
      );
    }

    const prompt = clean(g.prompt);
    if (!prompt) throw new Error(`"${name}" has no \`prompt:\` — the prompt is what the planning was for`);
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`"${name}"'s prompt is ${prompt.length} characters, over the ${MAX_PROMPT_CHARS} a group section may carry`);
    }
    for (const bad of FORBIDDEN) {
      if (prompt.includes(bad)) {
        throw new Error(
          `"${name}"'s prompt contains "${bad}", which belongs to the generated brief — the group section is injected into that brief, not instead of it`
        );
      }
    }

    groups.push({ name, repo: clean(g.repo) || [...repos][0] || null, beads, prs, prompt });
  }

  return { epic: epicId, groups };
}

/**
 * What this tick can actually dispatch, given a plan and the beads that are ready.
 *
 * Returns `{ groupOf, plannedInto, done }`:
 *   - `groupOf`     lead bead id → the group that window carries. One entry per group that
 *                   has ready work and nothing already running on it.
 *   - `plannedInto` every other ready bead of that group → the lead that speaks for it, so
 *                   the survey holds it rather than opening a second window in one group.
 *   - `done`        true when the plan has no ready work and no live session left anywhere
 *                   in it: every bead it named is closed, claimed by nobody, and gone from
 *                   the queue. That is the epic's work being in main, and it is what the
 *                   promotion bead is filed on.
 *
 * **The lead is whichever of the group's beads this tick's queue reaches first, and it moves.**
 * A fixed lead would be wrong the moment it closed: the window that carried the group would
 * be gone, its remaining beads would still be pointed at a closed bead, and nothing would
 * ever open again. Recomputing it per tick means a group that lost its window picks the
 * work back up on the next one, which is the same self-healing `batchesFor` gets from
 * being recomputed rather than remembered.
 *
 * **And a live worker anywhere in the group holds all of it.** Without that the lead leaves
 * `bd ready` the instant it is claimed, the next tick's "first in the queue" is the second
 * bead of the group, and one group gets two windows — which is bc-3zo9 with a plan instead
 * of a batch. `a.workers` keyed by bead id is the same evidence `batchesFor` uses for the
 * same question.
 *
 * **Same checkout only**, exactly as `batchesFor`: a group member whose `repo` differs from
 * its lead's is left out of the brief and takes its own window in its own tree later.
 * `validatePlan` already refuses a group whose *pull requests* span repos; this is the
 * runtime half, against labels that may have been corrected since the plan was written.
 */
export function dispatchable(plan, { queue = [], workers = [] } = {}) {
  const groupOf = new Map();
  const plannedInto = new Map();
  const ready = new Map((queue || []).map((b) => [b.id, b]));
  let anyLive = false;
  let anyReady = false;

  for (const group of plan.groups) {
    const live = (workers || []).find((w) => group.beads.includes(w.id));
    if (live) {
      anyLive = true;
      // Everything of this group that is somehow also in the queue waits for that window.
      for (const id of group.beads) if (ready.has(id)) plannedInto.set(id, live.id);
      continue;
    }
    const here = group.beads.filter((id) => ready.has(id));
    if (!here.length) continue;
    anyReady = true;
    const lead = here[0];
    const leadRepo = ready.get(lead).repo ?? null;
    const members = here.slice(1).filter((id) => (ready.get(id).repo ?? null) === leadRepo);
    groupOf.set(lead, {
      name: group.name,
      prompt: group.prompt,
      prs: group.prs,
      epic: plan.epic,
      beads: members.map((id) => ({ id, title: ready.get(id).title || '' })),
    });
    for (const id of here.slice(1)) plannedInto.set(id, lead);
  }

  return { groupOf, plannedInto, done: !anyLive && !anyReady };
}

/**
 * Ready beads under this epic that no group names.
 *
 * This is the event a supervisor is re-entered on. A child-worker files work it found
 * (bin/file.js, `--from` its own bead), Adam endorses it from his phone, and it comes up
 * ready under an epic whose plan was written before it existed — so there is a bead nobody
 * has grouped, and the plan is out of date rather than wrong. Re-opening the planner is
 * cheap, it is bounded (it writes a plan and exits), and its state was on the bead all
 * along, which is the whole reason the supervisor does not need to have been running.
 *
 * Note what is deliberately *not* an event: a bead closing. A group finishing needs no
 * supervision at all — the next tick simply dispatches the next group, because
 * `dispatchable` is recomputed from the queue every time.
 */
export function unplanned(plan, queue = []) {
  const named = new Set(plan.groups.flatMap((g) => g.beads));
  return (queue || []).filter((b) => isUnder(b.id, plan.epic) && !named.has(b.id));
}
