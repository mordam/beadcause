/**
 * Moving a bead into another bead-space — a copy under the new prefix, and the original
 * kept, closed and pointing at it.
 *
 * A bead filed in the wrong tracker is ordinary and has never had a move available to it.
 * The two things that look like one are not: `bd update --parent` reparents *inside* one
 * graph, and `bin/supersede.js` marks a duplicate somebody else already wrote. Filing it
 * again by hand in the right place and closing the first is what everybody actually does,
 * and it loses the thread every time — which is the failure this module exists to stop.
 *
 * ## Four decisions, and each of them is a refusal to do the obvious thing
 *
 * **The originals survive.** A bead id is a public reference: dependencies name it, pull
 * request titles name it, a branch and a worktree are named after it, and every archived
 * session is filed under it. Deleting the old family would leave all of that pointing at
 * nothing, so the old beads stay exactly where they are, each carrying
 * `superseded-by:<bead-space>/<new id>` — the marker lib/superseded.js already defines,
 * in its workspace-qualified form (bc-xl7n.71), because the successor is by construction
 * in another tracker. **Closed**, not left open: a marked-but-open bead is out of
 * `Bd.ready` by the label, but the whole point of a move is that there is now one live
 * copy, and two open beads describing one job is the state the marker was invented to
 * end.
 *
 * **Children are a parameter, not a rule.** `children: 'move'` takes the whole subtree
 * across in one import, remapped under the new root. `children: 'leave'` reparents each
 * direct child onto the departing bead's own parent first, so only the one bead crosses
 * and its children keep the ids everything else already names.
 *
 * **Leaving children behind with no grandparent mints an epic.** The departing bead is
 * about to be closed, a closed bead cannot hold open children, and there is no
 * cross-space parent edge to hang them off instead — so they need somewhere in the old
 * space to go. A new epic, titled by the caller and defaulted from the bead that is
 * leaving, is that somewhere. An epic rather than a task because `hasRootAbove` treats an
 * epic at any priority as a root, so the children stay workable rather than becoming the
 * "nothing decided above this" case lib/underroot.js reports. The engine never leaves a
 * bead parentless as a side effect of a move it was asked to make to another one.
 *
 * **The thread survives, which is why this is an export and not N creates.** `bd create`
 * carries no comments, and in this tracker a Beadcause *answer is a comment* — so a
 * decision bead re-created by hand arrives closed, stamped answered and empty, with
 * nothing to say what was decided. That is not hypothetical: it happened to the Halifax
 * graph on 2026-08-10 and three answers load-bearing for a P0 survived only because the
 * old workspace was still on disk. So the rows are exported, their ids remapped and the
 * result imported — the shape `tools/bd-workspace-migrate.mjs` uses for a whole
 * workspace, applied here to a subtree. Measured against bd 1.2.1: `bd import` accepts an
 * id whose prefix is foreign to the target, upserts by id, and carries labels, comments,
 * status, priority, type, close reasons and `parent-child` edges through unchanged.
 *
 * ## Which edges cross, and which are deliberately left behind
 *
 * Edges *within* the moving set are remapped to the new ids. Edges with one end staying
 * put are dropped from the copy and reported in `droppedEdges`, because no graph spans
 * two Dolt databases and a dependency naming a bead the target has never heard of is
 * silently discarded by `bd import` anyway (measured — no error, no edge, exit 0). They
 * are not lost: the surviving original still holds every one of them, which is the whole
 * reason keeping the originals is sufficient rather than merely polite. The departing
 * bead's own `parent-child` edge is one of these — the copy lands as a root in the target,
 * because a cross-space parent is the thing that cannot exist.
 *
 * ## What it refuses, and why those two
 *
 * **A live window on any bead being moved.** The process table is the only honest witness
 * to a live session (lib/onewindow.js), and a session mid-turn is holding a brief that
 * names ids this call is about to close. **An open pull request against any of them**, for
 * lib/inflight.js's reason: an open PR is a branch with commits on it, and the bead it
 * carries is work in flight whose id is in the PR title, the branch name and the delivery
 * block. Both are refusals rather than warnings and both name what is in the way.
 *
 * A `gh` that will not answer holds nothing back — `prCheck.reason` travels out and the
 * move goes ahead, which is lib/inflight.js's own doctrine: "I could not ask" is not
 * evidence of anything. What it must never do is fail *closed* and make an unreachable
 * GitHub the reason a tracker cannot be tidied.
 *
 * ## The dry run, and why the id map has to be real in it
 *
 * `dryRun` writes nothing and returns the whole plan: the id map, the children left
 * behind and where they are going, the epic it would mint, the edges it would drop. That
 * is only worth reading if the ids in it are the ids the real run will use — a plan
 * naming `<new id>` is a plan you cannot check. So `mintId` is a **deterministic** hash of
 * `<bead-space>/<id>`, not a random suffix and not something `bd create` hands back:
 * plan and apply agree by construction, and re-planning after a failed apply names the
 * same beads. Collisions bump a salt and are still deterministic; `bd.exists` is what
 * decides, so a second move of the same bead correctly mints a second id.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { linesNameBead, liveProcessLines } from './claude.js';
import { openWork, inflightWhy } from './inflight.js';
import { supersedeLabel } from './superseded.js';

/** What may be done with the children of the bead that is leaving. */
export const CHILD_MODES = ['move', 'leave'];

/** The same id shape lib/superseded.js and lib/server.js require, subtasks included. */
const ID_RE = /^[a-z][a-z0-9]*-[a-z0-9.]+$/i;

/** A prefix is a short word; anything else should produce no id, not a strange one. */
const PREFIX_RE = /^[a-z0-9]{1,10}$/i;

/** How many salted candidates to try before giving up on minting an id. */
const MINT_TRIES = 20;

const clean = (v) => String(v ?? '').trim();

/**
 * The new id one bead gets in the target bead-space.
 *
 * Deterministic on purpose — see the dry-run paragraph in the header. Five lowercase
 * base-36 characters after the prefix, which is the shape bd's own ids take (`bc-3wf1r`,
 * `bc-x1669`), so nothing downstream has to learn a second one. `salt` is what a
 * collision bumps, and it keeps the whole thing reproducible: the same bead, moved to the
 * same place, twice, gets the same two ids in the same order.
 */
export function mintId(prefix, workspaceName, id, salt = 0) {
  const seed = `${clean(workspaceName)}/${clean(id)}${salt ? `#${salt}` : ''}`;
  const digest = crypto.createHash('sha1').update(seed).digest('hex');
  const body = BigInt(`0x${digest.slice(0, 16)}`).toString(36).slice(0, 5).padStart(5, '0');
  return `${clean(prefix)}-${body}`;
}

/**
 * The prefix the target bead-space writes, without needing it to have any beads yet.
 *
 * `prefixFor` in lib/beadref.js reads it off a row, which is right for a tracker in use
 * and answers nothing at all for an empty one — and an empty tracker is a perfectly
 * ordinary destination for the first bead somebody moves into it. So a row first, and
 * `.beads/metadata.json`'s `dolt_database` — which `bd init` writes and which is
 * committed — second. Returns `''` when neither says anything, which is a refusal
 * upstream rather than a guess here: minting `undefined-a1b2c` is worse than not moving.
 */
export async function prefixOf(bd, ws) {
  try {
    const rows = await bd.json(ws, ['list', '--limit', '1']);
    const found = clean(rows?.[0]?.id).split('-')[0];
    if (PREFIX_RE.test(found)) return found.toLowerCase();
  } catch {
    // A tracker mid-write, or an empty one. Both fall through to the file.
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ws.dir, 'metadata.json'), 'utf8'));
    const named = clean(meta?.dolt_database);
    if (PREFIX_RE.test(named)) return named.toLowerCase();
  } catch {
    // No metadata, or not JSON. Nothing left to ask.
  }
  return '';
}

/** Every row `bd export` gives for a workspace, indexed by id. */
export function indexRows(jsonl) {
  const rows = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      continue;
    }
    // `--all` is not passed, but an export may still carry memory rows on a bd that
    // changed its mind about the default. A row with no id is nothing this can move.
    if (row?._type && row._type !== 'issue') continue;
    if (clean(row?.id)) rows.set(clean(row.id), row);
  }
  return rows;
}

/** The parent-child edge on a row, which is where bd keeps parenthood. */
export const parentOf = (row) =>
  clean((row?.dependencies || []).find((d) => clean(d?.type) === 'parent-child')?.depends_on_id);

/** Every direct child of `id` in an indexed export. */
export const childrenOf = (rows, id) =>
  [...rows.values()].filter((row) => parentOf(row) === clean(id)).map((row) => clean(row.id));

/**
 * The bead and everything under it, breadth-first so the root is always first.
 *
 * Walked off the export's own `parent-child` edges rather than off the dots in the ids,
 * for lib/ancestry.js's reason: `bd update --parent` does not renumber, so a bead adopted
 * into a subtree keeps a flat id and a bead moved out of one keeps a dotted one. The dots
 * are a naming convention and the edges are the graph.
 */
export function subtree(rows, id) {
  const root = clean(id);
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const next = queue.shift();
    if (seen.has(next) || !rows.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const kid of childrenOf(rows, next)) queue.push(kid);
  }
  return out;
}

/**
 * One exported row, rewritten for the target bead-space.
 *
 * `map` is old id → new id for everything crossing. Anything not in it is a bead staying
 * behind, so an edge naming it is dropped from the copy and pushed onto `dropped` for the
 * result to report. The row is rebuilt rather than mutated: the caller's index is read
 * again by the source-side writes below, and a shared object edited in place is how a
 * plan and its application quietly stop describing the same thing.
 */
export function remapRow(row, map, dropped = []) {
  const id = clean(row?.id);
  const next = { ...row, id: map.get(id) || id };
  const deps = [];
  for (const dep of row?.dependencies || []) {
    const other = clean(dep?.depends_on_id);
    if (!map.has(other)) {
      dropped.push({ from: id, to: other, type: clean(dep?.type) || 'depends-on' });
      continue;
    }
    deps.push({ ...dep, issue_id: next.id, depends_on_id: map.get(other) });
  }
  next.dependencies = deps;
  // Counts are bd's own summary of the two arrays and are recomputed on import; carrying
  // the source's would make `bd show` disagree with itself about a bead nobody has
  // touched.
  delete next.dependency_count;
  delete next.dependent_count;
  next.comments = (row?.comments || []).map((c) => ({ ...c, issue_id: next.id }));
  /**
   * The lease is the one thing that must not cross, and `status` is the one thing that
   * must.
   *
   * `lease_expires_at` and `heartbeat_at` are a claim on a *window*, and the window in
   * question was opened in the old bead-space against the old id — a live one is already
   * a refusal, so what would ride across here is always a dead session's lease, arriving
   * looking live. `status` and `assignee` stay, because the acceptance is that status
   * survives and because "who was working this" is a fact about the work rather than
   * about a process: `Bd.reopenAbandoned` is the door for putting that right, and it is
   * the same door an abandoned bead in one tracker already goes through.
   */
  delete next.lease_expires_at;
  delete next.heartbeat_at;
  return next;
}

/**
 * The edges that have to come off an original before bd will let it close.
 *
 * **Measured, not anticipated.** `bd close` refuses a bead that is blocked — *"cannot
 * close blocked issue: mv-wd9.1 is blocked by [mv-ear] (use --force to override)"* — and
 * being blocked by something outside the moving set is the ordinary case, not an exotic
 * one: a bead in the wrong tracker is very often the one waiting on work in the right one.
 * So without this the move ends with the copy in place and the original marked, open and
 * refusing to close for ever, which is exactly the half-state lib/superseded.js calls
 * invisible to every sweep.
 *
 * **`blocks` only, and only the outgoing half.** `blocks` is the one edge type bd polices
 * — measured against 1.2.1 in test/epicedgereal.mjs, of the ten types `dep add` accepts it
 * is the only one that takes a bead out of `bd ready` — so nothing else is in the way and
 * nothing else is touched. Outgoing, because an edge *into* the original lives on the
 * other bead's row and is precisely what keeping the originals preserves: `stays` still
 * records that it was blocked by this bead, and that sentence stays true for ever.
 *
 * **And what is dropped is a statement about work that has left.** Either it points at a
 * bead staying behind — in which case the thing that was waiting is now the copy, which
 * carries the remapped edge if it could and cannot carry this one at all — or at another
 * bead in the moving set, which is being closed in the same breath. On a closed tombstone
 * neither is something anybody can act on. `bd.dropDep`'s own header is the precedent: the
 * merge queue drops a work bead's edge onto its merge card for the same reason, in the
 * same breath as the close.
 *
 * Reported in `blockersToDrop` so the dry run says it out loud rather than surprising
 * somebody with a graph one edge lighter than they left it.
 */
export function blockingEdges(rows, moving) {
  const out = [];
  for (const id of moving) {
    for (const dep of rows.get(id)?.dependencies || []) {
      if (clean(dep?.type) !== 'blocks') continue;
      out.push({ from: id, to: clean(dep.depends_on_id) });
    }
  }
  return out;
}

/** The close reason an original carries afterwards — one line, naming where it went. */
export const closeReason = (to, newId) =>
  `Moved to ${clean(to)}/${clean(newId)}, which carries this bead's description, thread and labels. This one is kept because its id is still named elsewhere.`;

/**
 * The comment left on the copy, so the new bead says where it came from.
 *
 * On the copy rather than only in the original's close reason, because the two are read
 * by different people: the close reason is for whoever finds the dead id, and this is for
 * whoever opens the live one and wonders why its thread starts mid-conversation.
 */
export const arrivalNote = (from, oldId, to, newId) =>
  `Moved here from \`${clean(from)}/${clean(oldId)}\`, which is closed and marked ${supersedeLabel(`${clean(to)}/${clean(newId)}`)}. The old id is still what every pull request, branch and archived session names.`;

/** The title an epic minted for left-behind children gets when the caller names none. */
export const defaultEpicTitle = (row) => `${clean(row?.title) || clean(row?.id)} — the work left behind`;

/**
 * The body of that epic, which has to explain itself to whoever finds it next week.
 *
 * A root nobody can account for is worse than no root: lib/ownership.js and
 * lib/underroot.js both read roots, and an unexplained one reads as somebody's abandoned
 * plan. So it says outright that it is furniture created by a move, and names both ends.
 */
export const epicBody = (from, oldId, to, newId) =>
  `Created to hold the children of \`${clean(oldId)}\` when that bead moved to \`${clean(to)}/${clean(newId)}\`.\n\n` +
  `\`${clean(oldId)}\` had nothing above it in \`${clean(from)}\`, and it is closed now — a closed bead cannot hold open children and there is no parent edge that reaches another bead-space. These children stayed where they are because the move was asked for without them; retitle or reparent this epic freely, nothing depends on its wording.`;

/* ------------------------------------------------------------------------------ the plan */

/**
 * Everything the move would do, without doing any of it.
 *
 * Reads: one `bd export` of the source, one `ps`, one `gh pr list`. Writes: nothing at
 * all, which is what makes this safe to call for the dry run and again for the real one —
 * `moveSpace` calls it exactly once and hands the result to `applyMove`, so the plan you
 * were shown is the plan that runs.
 *
 * Returns `{ ok: false, refused }` for everything a caller could reasonably have got
 * wrong, and throws only for a tracker that will not answer at all — the same split
 * lib/newspace.js draws, and for the same reason: these end up as a sentence on a phone.
 */
export async function planMove(
  bd,
  {
    from,
    to,
    id,
    children = 'leave',
    epicTitle = '',
    dir = '',
    ps = null,
    prRows = null,
    prefix = null,
  } = {}
) {
  const bead = clean(id);
  const mode = clean(children) || 'leave';
  const plan = {
    ok: false,
    refused: '',
    from: clean(from?.name),
    to: clean(to?.name),
    id: bead,
    children: mode,
    prefix: '',
    map: [],
    moving: [],
    leaving: [],
    parent: '',
    epic: null,
    droppedEdges: [],
    blockersToDrop: [],
    blockers: [],
    prCheck: { ok: false, reason: '' },
    rows: new Map(),
  };

  if (!from?.name || !from?.dir) return { ...plan, refused: 'the bead-space to move out of has to be named' };
  if (!to?.name || !to?.dir) return { ...plan, refused: 'the bead-space to move into has to be named' };
  if (plan.from === plan.to) {
    return { ...plan, refused: `${plan.from} is already where that bead lives — moving it there would copy it onto itself` };
  }
  if (!ID_RE.test(bead)) return { ...plan, refused: `${bead || 'that'} is not a bead id` };
  if (!CHILD_MODES.includes(mode)) {
    return { ...plan, refused: `children may be ${CHILD_MODES.join(' or ')}, not ${mode}` };
  }

  const targetPrefix = clean(prefix) || (await prefixOf(bd, to));
  if (!PREFIX_RE.test(targetPrefix)) {
    return { ...plan, refused: `cannot read an id prefix for ${plan.to}, and a bead cannot be given an id in a bead-space that will not say what its ids look like` };
  }
  plan.prefix = targetPrefix;

  const rows = indexRows(await bd.run(from, ['export']));
  plan.rows = rows;
  const row = rows.get(bead);
  if (!row) return { ...plan, refused: `there is no bead ${bead} in ${plan.from}` };

  plan.parent = parentOf(row);
  const kids = childrenOf(rows, bead);
  plan.moving = mode === 'move' ? subtree(rows, bead) : [bead];

  /**
   * Minting is the one part of the plan that asks the *target* anything, and it asks the
   * cheapest question there is. Sequential rather than parallel because a collision bumps
   * a salt and two candidates minted at once could collide with each other rather than
   * with the tracker — which would be a bug nothing would ever reproduce.
   */
  const map = new Map();
  const taken = new Set();
  const mint = async (source) => {
    for (let salt = 0; salt < MINT_TRIES; salt += 1) {
      const candidate = mintId(targetPrefix, plan.from, source, salt);
      if (taken.has(candidate)) continue;
      if (await bd.exists(to, candidate)) continue;
      taken.add(candidate);
      return candidate;
    }
    return '';
  };

  const rootId = await mint(bead);
  if (!rootId) {
    return { ...plan, refused: `could not find a free id for ${bead} in ${plan.to} after ${MINT_TRIES} tries` };
  }
  map.set(bead, rootId);
  for (const moving of plan.moving) {
    if (moving === bead) continue;
    /**
     * A descendant whose id sits *under* the moving bead's keeps its position, which is
     * what makes the map readable: `bc-ka5y.42.1` under `sp-a1b2c` is `sp-a1b2c.1`, and no
     * second hash is needed because the root's uniqueness carries the whole subtree.
     *
     * **And one that does not has to be minted its own, which is not a corner case.**
     * `bd update --parent` does not renumber (`Bd.adopt` says so outright), so a bead
     * adopted into a subtree keeps whatever flat id it was born with: `mv-zzz9` can
     * perfectly well be a child of `mv-a`. Slicing a prefix off an id that never carried
     * it produces a garbled string — `mv-zzz9` under `mt-x1y2z` came out `mt-x1y2zzz9` —
     * which is not a subtask id, not a root id, and not anything bd or lib/ancestry.js
     * would recognise. So it gets a root-shaped id of its own and its `parent-child` edge
     * carries the parenthood, exactly as it did on this side.
     */
    const under = moving.startsWith(`${bead}.`);
    const minted = under ? `${rootId}${moving.slice(bead.length)}` : await mint(moving);
    if (!minted) {
      return { ...plan, refused: `could not find a free id for ${moving} in ${plan.to} after ${MINT_TRIES} tries` };
    }
    if (under) taken.add(minted);
    map.set(moving, minted);
  }
  plan.map = [...map.entries()];

  if (mode === 'leave' && kids.length) {
    const landing = plan.parent;
    if (landing) {
      plan.leaving = kids.map((kid) => ({ id: kid, title: clean(rows.get(kid)?.title), to: landing }));
    } else {
      plan.epic = {
        needed: true,
        title: clean(epicTitle) || defaultEpicTitle(row),
        priority: Number.isInteger(row?.priority) ? row.priority : 2,
      };
      plan.leaving = kids.map((kid) => ({ id: kid, title: clean(rows.get(kid)?.title), to: '' }));
    }
  }

  // Read once, so the plan reports exactly the edges the import will be missing.
  const dropped = [];
  for (const moving of plan.moving) remapRow(rows.get(moving), map, dropped);
  plan.droppedEdges = dropped;
  plan.blockersToDrop = blockingEdges(rows, plan.moving);

  /* ------------------------------------------------------------------- what is in the way */

  /**
   * One process table, N cheap filters — not `liveProcessesNaming` per bead, which takes
   * its own `ps` each time. A `children: 'move'` of a mature subtree is a dozen beads and
   * that would be a dozen full reads of every process on the Mac for one question, on the
   * same machine that has four gates running on it.
   *
   * The pid is what a person reading the refusal actually needs — `ps -p <pid> -o args
   * -ww` prints the other window's whole brief — which is why this filters line by line
   * rather than asking `linesNameBead` for a boolean about the lot.
   */
  const lines = await liveProcessLines(ps ? { ps } : {}).catch(() => []);
  for (const moving of plan.moving) {
    for (const line of lines) {
      if (!linesNameBead([line], plan.from, moving)) continue;
      plan.blockers.push({ id: moving, why: `a window is working it right now (pid ${line.pid})` });
    }
  }

  if (dir) {
    const open = await openWork(bd, from, dir, { rows: prRows }).catch((err) => ({
      ok: false,
      reason: String(err?.message || err).split('\n')[0],
      beads: new Map(),
    }));
    plan.prCheck = { ok: Boolean(open.ok), reason: clean(open.reason) };
    for (const moving of plan.moving) {
      const hit = open.beads?.get(moving);
      if (hit) plan.blockers.push({ id: moving, why: inflightWhy(hit) });
    }
  } else {
    plan.prCheck = { ok: false, reason: 'no checkout is attached to this bead-space, so no pull request could be asked about' };
  }

  if (plan.blockers.length) {
    const named = plan.blockers.map((b) => `${b.id} — ${b.why}`).join('; ');
    return { ...plan, refused: `${plan.blockers.length === 1 ? 'a bead' : 'beads'} in this move ${plan.blockers.length === 1 ? 'is' : 'are'} still in flight: ${named}` };
  }

  plan.ok = true;
  return plan;
}

/* ----------------------------------------------------------------------------- doing it */

/**
 * Write the remapped rows into the target, in one `bd import`.
 *
 * A file rather than a pipe because `Bd.run` is `execFile` with no stdin — deliberately,
 * for lib/bd.js's reason at the top of that file — and `bd import -` would need one. The
 * temp directory is this process's, removed whatever happens, so a failed import leaves
 * nothing behind but the sentence bd said.
 */
export async function importRows(bd, to, rows, { actor = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-move-'));
  const file = path.join(dir, 'moved.jsonl');
  try {
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return await bd.run(to, ['import', file], { retries: 2, actor });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Carry out a plan `planMove` said `ok` to.
 *
 * **Order, and it is the whole of the care this needed.** The copy is written *first*, so
 * that every later failure leaves a target that has the work and a source that is exactly
 * as it was — one bead described twice, which is visible and fixable, rather than a
 * subtree closed over a copy that never arrived. Then the source side, in the only order
 * that cannot leave a bead worse than it started:
 *
 * 1. **the epic, then the reparents** — children have to be somewhere before their parent
 *    closes, because a closed bead cannot hold open ones.
 * 2. **the blocking edges off the originals**, because bd refuses to close a blocked bead
 *    and being blocked by something that is staying put is the ordinary case rather than
 *    an exotic one. `blockingEdges` is what decides which, and why it costs nothing.
 * 3. **the marker, then the close** — lib/superseded.js's order, for its reason: the label
 *    is what holds the bead out of `Bd.ready` and out of `openWorkSession`, so a failure
 *    after it leaves a bead that is *held* and short of a close rather than one that is
 *    released and unmarked.
 * 4. **deepest first** among the originals, so an epic is never asked to close over a
 *    child that has not been closed yet.
 *
 * Never throws for a write that failed: every one is caught and named in `problems`, and
 * `ok` is false when there are any. A half-done move whose remaining steps are written
 * down is something a person can finish; an exception thrown from the middle of one is a
 * tracker in a state nobody can see.
 */
export async function applyMove(bd, plan, { from, to, actor = null } = {}) {
  const out = {
    ...plan,
    applied: false,
    imported: 0,
    closed: [],
    reparented: [],
    epicId: '',
    unblocked: [],
    problems: [],
  };
  if (!plan?.ok) return out;

  const map = new Map(plan.map);
  const rowFor = (id) => plan.rows.get(id);

  // 1. The copy.
  try {
    const payload = plan.moving.map((id) => remapRow(rowFor(id), map));
    await importRows(bd, to, payload, { actor });
    out.imported = payload.length;
  } catch (err) {
    out.problems.push(`nothing was copied into ${plan.to} — ${firstLine(err)}. The source is untouched.`);
    return out;
  }

  const newRoot = map.get(plan.id);

  // A sentence on the copy saying where it came from. Worth having and not worth failing
  // over: the bead is already there, and losing the note would undo nothing.
  await bd.comment(to, newRoot, arrivalNote(plan.from, plan.id, plan.to, newRoot), { actor }).catch(() => {});

  // 2. Somewhere for the children that are staying.
  if (plan.epic?.needed) {
    try {
      out.epicId = await bd.create(
        from,
        {
          title: plan.epic.title,
          body: epicBody(plan.from, plan.id, plan.to, newRoot),
          type: 'epic',
          priority: plan.epic.priority,
          labels: [],
        },
        { actor }
      );
    } catch (err) {
      out.problems.push(`could not create the epic for ${plan.leaving.length} left-behind child(ren) — ${firstLine(err)}`);
    }
  }

  const landing = plan.epic?.needed ? out.epicId : plan.parent;
  for (const kid of plan.leaving) {
    if (!landing) {
      out.problems.push(`${kid.id} has nowhere to go — it is still a child of ${plan.id}, which is about to close`);
      continue;
    }
    try {
      await bd.adopt(from, kid.id, landing, { actor, refresh: false });
      out.reparented.push({ id: kid.id, to: landing });
    } catch (err) {
      out.problems.push(`could not reparent ${kid.id} onto ${landing} — ${firstLine(err)}`);
    }
  }

  // A child this could not move is a child the close below would be asked to close over,
  // and forcing that is exactly the thing `Bd.close` refuses to guess at. Stop here: the
  // copy exists, the originals are unmarked and open, and the sentence says what to fix.
  if (plan.leaving.length && out.reparented.length !== plan.leaving.length) {
    out.problems.push(`${plan.id} was left open and unmarked, because closing it would have closed over a child that could not be moved`);
    return out;
  }

  // 3. Take the blocking edges off, so the closes below are not refused over work that
  //    has left. See `blockingEdges` for what is dropped and why it costs nothing.
  for (const edge of plan.blockersToDrop) {
    try {
      await bd.dropDep(from, edge.from, edge.to);
      out.unblocked.push(edge);
    } catch (err) {
      out.problems.push(`could not drop ${edge.from}'s blocking edge onto ${edge.to} — ${firstLine(err)}. Its close below will probably be refused over it.`);
    }
  }

  // 4. Mark and close every original, deepest first.
  for (const id of [...plan.moving].reverse()) {
    const target = `${plan.to}/${map.get(id)}`;
    try {
      await bd.addLabel(from, id, supersedeLabel(target));
    } catch (err) {
      out.problems.push(`could not mark ${id} ${supersedeLabel(target)} — ${firstLine(err)}. It is still open and unmarked.`);
      continue;
    }
    /**
     * A descendant that was already closed needs the marker and nothing else.
     *
     * `subtree` walks every child whatever its status, deliberately — the record of
     * finished work under a bead is part of what moves — so a `children: 'move'` of a
     * mature subtree routinely carries closed rows. Re-closing one would either fail and
     * report a problem that is not one, or overwrite a close reason that says what
     * actually happened with one that says it was moved. The marker is the whole of what
     * such a bead is short of.
     */
    if (clean(rowFor(id)?.status).toLowerCase() === 'closed') {
      out.closed.push(id);
      continue;
    }
    try {
      // `overClaim`, and it is narrow: `Bd.close` only forces when bd's own refusal was
      // the claim guard. A live session was refused by the plan, so what is left here is
      // a *stale* assignee — and a stale claim must not be able to leave a bead marked
      // superseded and open for ever, which is the one state lib/superseded.js says is
      // invisible to every sweep.
      await bd.close(from, id, closeReason(plan.to, map.get(id)), { actor, overClaim: true });
      out.closed.push(id);
    } catch (err) {
      out.problems.push(`${id} is marked ${supersedeLabel(target)} but would not close — ${firstLine(err)}`);
    }
  }

  // Both shapes have changed under everything that caches them — beads closed and
  // reparented on one side, beads that did not exist a second ago on the other. The
  // adopts above are all `refresh: false` for lib/adoptsweep.js's reason, so this is the
  // one rebuild the whole move pays for rather than one per write.
  await Promise.all([
    bd.graph(from, { refresh: true }).catch(() => {}),
    bd.graph(to, { refresh: true }).catch(() => {}),
  ]);

  out.applied = true;
  out.ok = out.problems.length === 0;
  return out;
}

/** The first line bd actually said, rather than Node's account of an exit code. */
function firstLine(err) {
  const text = clean(err?.message || err);
  return text.split('\n').filter(Boolean)[0] || 'no reason given';
}

/**
 * Plan it, and unless this is a dry run, do it.
 *
 * One entry point, because the plan and the application must never be computed from two
 * different reads of the tracker — the id map in particular is only trustworthy if the
 * thing that shows it to you is the thing that uses it.
 */
export async function moveSpace(bd, opts = {}) {
  const plan = await planMove(bd, opts);
  if (!plan.ok || opts.dryRun) return { ...plan, applied: false, dryRun: Boolean(opts.dryRun) };
  const done = await applyMove(bd, plan, { from: opts.from, to: opts.to, actor: opts.actor || null });
  return { ...done, dryRun: false };
}

/**
 * The plan without the export index hanging off it.
 *
 * `rows` is a `Map` of every bead in the source workspace and has no business on the
 * wire or in a log line — it is an implementation detail of the one call that computes
 * both halves. Everything else is exactly what the dry run is for.
 */
export function publicPlan(plan) {
  const { rows, ...rest } = plan || {};
  return rest;
}
