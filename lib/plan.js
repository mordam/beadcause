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
 * ## And what two groups may not both be
 *
 * A plan is the one document in this system where somebody decides, in one sitting, what
 * several windows will each go and do. That makes it the only place a file collision can
 * be *designed out* rather than arbitrated afterwards — so a group may declare its
 * `files:`, and `validatePlan` refuses a plan whose groups intersect within one repo. It
 * is a refusal for the same reason a group spanning two repos is: both look fine and fail
 * an hour later in a window nobody is watching, and the planner is the only party still
 * holding the context to split them.
 *
 * This is the *strict* end of lib/beadfiles.js's rules, and deliberately stricter than the
 * dispatcher's. Everywhere else in bc-42ow a surface is a **forecast**, so an overlap is a
 * risk to be weighed — a declared one may defer a bead a tick (`withoutCollidingSiblings`)
 * and a guessed one may not withhold work at all (bc-hrno). A plan is a **decomposition
 * somebody just made**, so an overlap in one is not a fact about the world, it is a bug in
 * the plan, and it is refused outright. A group that declares nothing is legal and
 * intersects nothing, exactly as an undeclared bead does.
 *
 * The overlap test itself comes from lib/beadfiles.js and is not copied here. A plan that
 * computed overlap differently from the dispatcher would be the worst outcome available:
 * two mechanisms that both believe they are reading one field.
 *
 * Nor may a plan endorse anything. The beads an epic worker files go through bin/file.js
 * like every other agent-filed bead and arrive `unendorsed`; lib/endorse.js is two layers
 * on purpose and neither of them has an exception for a planner. Naming an unendorsed bead
 * in a group is not an error — the group simply cannot dispatch it until Adam has looked
 * at it, because it is not in `bd ready` — and that is the gate working, not a failure.
 */
import { ancestorsOf } from './ancestry.js';
import { normalizeSurface, overlap, surfaceOf } from './beadfiles.js';

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
 * Is this bead under that epic — by the graph where there is one, by the id where there
 * is not.
 *
 * **The id alone is not the answer, and believing it was is bc-rfnr.9's bug.** bd's ids
 * are hierarchical when a bead is *created* under a parent (`bc-x.1.2`), and they are not
 * when one is *adopted* into it: `bd update <bead> --parent=<epic>` moves the edge and
 * renumbers nothing, so a real child keeps whatever id it was filed with. Measured on
 * 2026-08-17: bc-6s96 and bc-s8mc are children of bc-rfnr.9 in `bd children`, in the
 * export's parent edges and on the P0 card, and the prefix test said no to all of it. A
 * plan could not name them and `unplanned` could not see them, so they could never be
 * grouped and never counted towards `done` — an epic silently unable to plan part of
 * itself, with nothing anywhere saying why.
 *
 * `parents` is lib/ancestry.js's `Map(child → parent)`, which every caller here already
 * has from the same per-tick export it reads everything else from. Passing none is
 * allowed and falls back to the prefix, because that is still right for every bead that
 * *was* created under its parent, and a caller with no graph must not start answering
 * "no" to questions it used to answer "yes" to.
 *
 * Importing `ancestorsOf` from lib/ancestry.js rather than copying its walk: that file is
 * a leaf — it imports nothing — so the cycle this function's previous note was avoiding
 * (lib/advocate.js imports this one) does not exist in this direction.
 */
export const isUnder = (id, ancestor, parents = null) =>
  Boolean(
    id &&
      ancestor &&
      (String(id).startsWith(`${ancestor}.`) || ancestorsOf(parents, String(id)).includes(String(ancestor)))
  );

/**
 * Does the tracker say this bead has **closed**?
 *
 * Only ever true on a row that says so. A bead the index has no row for — a cold or failed
 * `bd export`, an id a hand-written plan named and the tracker has never had — is not closed
 * and must not read as closed; that direction is the whole of bc-4bet.2. `beads` is
 * lib/ancestry.js's `Map(id → row)`, and a plain object is accepted too so a caller with a
 * literal does not have to build a Map to ask.
 */
const isClosed = (beads, id) => {
  const row = typeof beads?.get === 'function' ? beads.get(id) : beads?.[id];
  return Boolean(row) && String(row.status || '').toLowerCase() === 'closed';
};

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
    // The surface goes on the human-readable line as well as into the JSON, because the
    // person reading this comment is the one who can see that two groups were split along
    // the wrong seam — and that is only visible if the seam is written down. A group that
    // declared nothing says nothing, rather than saying "touches" and then nothing: the
    // absence is the honest rendering of a plan that made no forecast.
    ...plan.groups.map(
      (g) => `- **${g.name}** — ${g.beads.join(', ')}${g.files?.length ? ` · touches ${g.files.join(', ')}` : ''}`
    ),
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
      // `children` is the tracker's own answer and outranks the id: a bead adopted with
      // `bd update --parent` is a child with an unrelated id, and asking the prefix first
      // refused it before this line was ever reached. Where the tracker could not be read
      // `known` is null and the id is all there is, which is the right fallback and the
      // wrong primary.
      if (known) {
        if (!known.has(id)) throw new Error(`"${name}" names ${id}, which ${epicId} has no child by`);
      } else if (!isUnder(id, epicId)) {
        throw new Error(`"${name}" names ${id}, which is not under ${epicId}`);
      }
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

    const repo = clean(g.repo) || [...repos][0] || null;
    // `touches:`, `paths:` and `surface:` alongside `files:` for the reason `declaredFiles`
    // keeps its three property names: a planner writing YAML by hand at the end of a long
    // window reaches for whichever word it was thinking in, and a spelling this silently
    // ignored would be a declaration that never fired — the one failure worse than no field.
    const files = normalizeSurface(g.files ?? g.touches ?? g.paths ?? g.surface ?? null);
    // Against the groups already accepted, so the group named as colliding is the *earlier*
    // one — which is the one the planner wrote first and is most likely to keep, and so the
    // useful half of "these two collide". Only within one repo: two groups in two checkouts
    // naming `lib/x.js` name two different files. A group that declared nothing is skipped
    // on both sides, which is what makes declaring nothing legal rather than merely quiet.
    for (const done of files.length ? groups : []) {
      if (!done.files.length) continue;
      if (repo && done.repo && repo !== done.repo) continue;
      const hits = overlap(files, done.files);
      if (!hits.length) continue;
      throw new Error(
        `"${name}" and "${done.name}" both expect to touch ${hits.map((h) => h.path).join(', ')} — ` +
          'two windows editing one file is a conflict you are deciding to create; put them in one group, ' +
          'or move the shared file to whichever of them owns it'
      );
    }

    groups.push({ name, repo, beads, prs, prompt, files });
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
 *   - `done`        true when the tracker says **every bead the plan named has closed**, and
 *                   no live session is left anywhere in it. That is the epic's work being in
 *                   main, and it is what the promotion bead is filed on.
 *   - `unclosed`    the named beads it could not see closed — what `done` is false *because
 *                   of*, so the survey can say which beads an epic is still waiting on rather
 *                   than only that it is.
 *
 * ## Why `done` is a status check and not a queue check (bc-4bet.2)
 *
 * It used to be `!anyLive && !anyReady` — nothing running, nothing in the queue — and that
 * reads **not-ready as done**. The queue here is the survey's, built with
 * `bd.ready(..., { excludeLabels: QUEUE_EXCLUDED })`, so a bead that is `unendorsed` is not
 * in it — nor is one carrying `human` and waiting on an answer, nor one blocked behind a
 * dependency. Every one of those is open work that has never started, and every one of them
 * was indistinguishable from a group that had finished. bc-1kwl.9 is what that cost: a promotion bead filed on 2026-08-14 saying "every bead under bc-1kwl is closed, so
 * its work is in main", over an epic two of whose three named beads had never been touched.
 *
 * A promotion bead is a chore that asks a release agent for UAT and production, so a false
 * premise stated as fact on one is worse than no bead at all. The rule lib/release.js holds
 * to and lib/promote.js's own prose already claimed — *we-cannot-say settles nothing, ever* —
 * is now what the code asks: not-endorsed, dependency-blocked, and simply absent from the
 * index are all we-cannot-say, and every one of them keeps `done` false.
 *
 * `beads` is the tracker's own rows, `Map(id → {status})` — lib/ancestry.js's index, which
 * the advocate already reads once a tick and shares (`tickBeads`), so this costs no call of
 * its own. **Not passing it means not-done**, deliberately: a caller with no index cannot
 * say that anything closed, and a cold or failed `bd export` is exactly the moment a
 * default of "done" would file the bead nobody can un-say.
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
export function dispatchable(plan, { queue = [], workers = [], beads = null } = {}) {
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

  // Every bead the plan named, and which of them the tracker will not call closed. A plan
  // that names none is not a finished plan, it is a malformed one — `validatePlan` refuses
  // a group with no beads, but `readPlan` parses a comment nobody validated, so an empty
  // set here is we-cannot-say rather than nothing-left-to-do.
  const named = [...new Set(plan.groups.flatMap((g) => g.beads || []))];
  const unclosed = named.filter((id) => !isClosed(beads, id));

  return { groupOf, plannedInto, unclosed, done: !anyLive && !anyReady && named.length > 0 && !unclosed.length };
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
 * `parents` is the export's parent edges, and without them this misses exactly the child
 * that `bd update --parent` adopted in — which is the same child `validatePlan` would then
 * refuse to let the rewritten plan name. The two have to be given the same graph or the
 * planner is re-opened to fix something it is not allowed to fix.
 *
 * Note what is deliberately *not* an event: a bead closing. A group finishing needs no
 * supervision at all — the next tick simply dispatches the next group, because
 * `dispatchable` is recomputed from the queue every time.
 */
export function unplanned(plan, queue = [], parents = null) {
  const named = new Set(plan.groups.flatMap((g) => g.beads));
  return (queue || []).filter((b) => isUnder(b.id, plan.epic, parents) && !named.has(b.id));
}

/**
 * What a plan did **not** say, and what its groups look like they will collide over anyway.
 *
 * bc-zjab.1. `validatePlan` refuses two groups that declare the same file, and that refusal is
 * the one automatic check there is on a grouping — but `files:` is optional, so the check is
 * opt-out, and a plan that skipped it exits 0 with a clean summary exactly like a plan that
 * passed it. Measured on bc-y3qk on 2026-08-18: the planner declared `files:` on neither of
 * its two groups, reasoning — correctly — that a wrong declaration is a hard refusal while
 * declaring nothing is legal, and bin/plan.js agreed with it silently. So the planner reasoned
 * its way out of the only check on its own work and nothing anywhere said so.
 *
 * **Nothing here is a refusal, and `files:` stays optional.** A bead whose file surface is
 * genuinely not known yet is a real and legitimate state early in an epic — lib/beadfiles.js
 * is explicit that a missing surface must never withhold work — so making the field mandatory
 * would refuse plans for being honest. What was wrong was never that declaring nothing is
 * legal; it is that legal and unremarked were the same thing. These are the remarks.
 *
 * Two of them:
 *
 *   1. **A group that declared nothing** gets a line naming the check that did not run for it.
 *   2. **Two groups whose *derived* surfaces meet** get a line saying so — derived from the
 *      beads' own text, which is the same reading lib/beadfiles.js already does for the
 *      dispatcher's "another session is editing lib/server.js — which this bead's text names".
 *      A guess may not withhold work (bc-hrno), but it is easily good enough for a sentence.
 *
 * **The overlap test is `overlap` and is not reimplemented**, for the reason this file's header
 * gives about `validatePlan`: a plan computing overlap differently from the dispatcher would be
 * two mechanisms both believing they read one field. This adds no third reading — it asks the
 * same question of a weaker input, and says on every line which input it asked.
 *
 * The surface for a group that declared one is that declaration; for a group that did not it is
 * the union of what its beads' own rows yield. That is `surfaceOf`'s rule — declared wins
 * outright and is never merged with the guess — asked one level up, and the same argument
 * carries: a group that said what it will touch has said it, and the prose around it is
 * commentary. So a pair reaching the second loop always has at least one guessed side, because
 * a declared/declared pair that overlapped never got past `validatePlan`.
 *
 * Pure, and everything that needs a disk is a parameter — `beads` is whatever rows the caller
 * managed to read, `dirs` the checkouts a guessed path has to exist in. Both may be empty, and
 * empty means fewer notes rather than an error: a caller that could not read the tracker must
 * not turn a warning into a failure. `dirs` entries are `{ name, dir }` as the advocate's
 * `repoDirs` builds them, or bare path strings; where they carry names the list is narrowed to
 * the group's own repo, because a path named in one Climative bead exists in thirty of the
 * forty checkouts and means the one the group would be worked in.
 */
export function surfaceNotes(plan, { beads = null, dirs = [] } = {}) {
  const rows = new Map();
  if (typeof beads?.get === 'function') for (const [id, row] of beads) rows.set(id, row);
  else if (Array.isArray(beads)) for (const row of beads) if (row?.id) rows.set(row.id, row);
  else if (beads && typeof beads === 'object') for (const [id, row] of Object.entries(beads)) rows.set(id, row);

  const where = (dirs || []).map((d) => (typeof d === 'string' ? { name: null, dir: d } : d)).filter((d) => d?.dir);
  const named = where.some((d) => d.name);
  const dirsFor = (repo) => (named && repo ? where.filter((d) => d.name === repo) : where).map((d) => d.dir);

  const notes = [];
  const seen = [];

  for (const g of plan.groups || []) {
    const declared = (g.files || []).length > 0;
    if (!declared) {
      notes.push(
        `"${g.name}" declares no \`files:\`, so the check that no two groups are sent at one file did not run for it — ` +
          'legal, since a surface nobody knows yet is a real state, but not the same as having passed it'
      );
    }
    // The whole row where the caller had one, and nothing where it did not: a bead the tracker
    // would not hand over is a bead whose surface cannot be guessed, which is a quieter answer
    // rather than a wrong one.
    const here = declared ? [] : dirsFor(g.repo);
    const derived = declared
      ? []
      : [...new Set((g.beads || []).flatMap((id) => surfaceOf(rows.get(id) || null, here).files))];
    seen.push({ name: g.name, repo: g.repo, files: declared ? g.files : derived, declared });
  }

  for (const [i, g] of seen.entries()) {
    if (!g.files.length) continue;
    // Against the groups already passed, so the group named second is the *earlier* one —
    // `validatePlan`'s order, and for its reason: the earlier one is what the planner wrote
    // first and is most likely to keep, so it is the useful half of "these two collide".
    for (const done of seen.slice(0, i)) {
      if (!done.files.length || (g.declared && done.declared)) continue;
      if (g.repo && done.repo && g.repo !== done.repo) continue;
      const hits = overlap(g.files, done.files);
      if (!hits.length) continue;
      const how =
        g.declared || done.declared
          ? `"${g.declared ? g.name : done.name}" declared that and "${g.declared ? done.name : g.name}" was read off its beads' own text`
          : "neither declared a surface, so both were read off their beads' own text";
      notes.push(
        `"${g.name}" and "${done.name}" both look like they touch ${hits.map((h) => h.path).join(', ')} — ` +
          `${how}, which makes this an observation and not a refusal; declare \`files:\` on both if it is right`
      );
    }
  }

  return notes;
}
