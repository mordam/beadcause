/**
 * The `Adopts:` line applied — an epic's claim becoming an edge, on the tick.
 *
 * bc-arj0.2, and the other half of lib/adopts.js. That file reads the line; this one is
 * what makes reading it worth anything. Measured on the bc graph on 2026-08-13: seven
 * epics carried a list, ninety beads were named, **not one adoption was an edge** — so
 * `bd list --parent bc-ka5y` said "has no children" over twenty-three of them, `bd dep
 * tree` drew a single node, and six of the seven epics then closed on a pull request
 * merge with sixty adoptees still open, taking the classification with them.
 *
 * The convention is real and agents reach for it unprompted, which is the whole argument
 * for applying it rather than asking them to stop: an `Adopts:` line is what an epic
 * writes when it means "this is mine", and a tracker that ignores it is a tracker holding
 * less than the prose beside it. Since bc-arj0.3 the close gate refuses an epic over an
 * unapplied entry, so the line already *costs* something; without this it costs a person
 * a hand-write per bead, thirty a week, for a structure the daemon could keep itself.
 *
 * ## What it will and will not do
 *
 * The rule is one sentence: **an adoption is applied only where it is free.** Every
 * refusal below is a case where applying it would destroy something that was decided on
 * purpose, and the daemon is the wrong thing to be deciding those unattended.
 *
 * - **A bead that already has a parent keeps it.** The existing edge is somebody's
 *   decision — a filing, a tap on the phone's adopt control, another epic's list applied
 *   first — and a line in a description is not evidence that it was wrong. This is the
 *   drift the close gate then reports on the epic, in the one place a person is already
 *   looking at the question. (bc-4bet names bc-d5sv and bc-mari, both children of
 *   bc-xl7n.1: exactly this, and it wants arbitration rather than a rule.)
 * - **A bead already linked to this epic by any other edge keeps that too.** bd holds
 *   one edge per pair of any type in either direction — pinned against the real binary in
 *   test/epicedgereal.mjs — so `bd update <bead> --parent=<epic>` over the
 *   `discovered-from` edge `bin/file.js --from` leaves behind is refused, and the only way
 *   to "apply" it is to delete the provenance first. A daemon that quietly traded *where
 *   this bead came from* for *who claims it* would be destroying the older fact of the two
 *   on a thirty-second clock. Knowing this from the index rather than from a failed write
 *   is also what stops a doomed `bd` spawn every tick for as long as the line says so.
 * - **Except a `relates-to`, which is replaced.** The one exception, and without it this
 *   whole file applies nothing on a graph beadcause has been running against: lib/mentions.js
 *   turns a bead id written in prose into a see-also edge as it is written, and the ids in
 *   an `Adopts:` line are bead ids written in prose. So an epic filed through beadcause's
 *   own seam arrives already related to everything it adopts, every adoption is then
 *   refused by the rule above, and the close gate holds the epic open forever over a list
 *   that can never be applied. Replacing it loses nothing, which is the whole of the
 *   argument: lib/mentions.js is explicit that `relates-to` claims only *mentioned near*,
 *   and a parent link says everything it said and more. Provenance is not like that, which
 *   is why `discovered-from` is not on this list.
 * - **A bead two epics both name is refused for both**, naming the other epic. There is
 *   no answer here that is not a judgement, applying either one makes the second refusal
 *   permanent and invisible, and the order two epics happen to be exported in is not a way
 *   to pick. bc-arj0.2 says outright that this is a question for Adam rather than a rule;
 *   until it is asked, the safe answer is the one that changes nothing.
 * - **An id that names no bead here is refused**, which is a typo or another workspace's
 *   prefix — the gate holds the epic over it either way, and that sentence on the phone is
 *   how a typo gets found.
 * - **A closed epic adopts nothing.** Its list is a record of what it covered, and moving
 *   live work under a closed parent is how a bead becomes held and invisible (lib/underroot.js:
 *   nothing open above it, so no advocate queues it and the inbox does not draw it).
 * - **A cycle is refused**, because the epic being a descendant of the bead it names makes
 *   the graph unwalkable and lib/ancestry.js would then be answering a question about a
 *   loop. bd refuses this itself; asking is what costs the spawn.
 *
 * ## Why it is shaped as an outcome rather than as a throw
 *
 * lib/sync.js is the precedent and lib/server.js's cycle is the reason: a sweep in the
 * poll cycle that throws lands in a catch whose bar is *this is a bug*
 * (`reportSweepFailure`), so a Dolt write lock — the ordinary condition here, with twenty
 * agent sessions sharing the workspace — must not reach it. Every failure is a row in the
 * answer, and the sweep returns one whatever happens.
 *
 * ## What it does not owe the phone
 *
 * A sweep that fills a payload field owes a bus event, or its data reaches the browser
 * only when something else happens to move. This one fills none: what it changes is the
 * tracker, `bd update --parent` bumps `updated_at`, and the change detector in
 * lib/detect.js is watching exactly that — so the poll's own sweep redraws the P0 tree on
 * the next beat, through the path every other write to bd already takes.
 */
import { ancestorsOf, pairKey } from './ancestry.js';
import { RELATED_EDGES } from './mentions.js';

/** bd's word for an epic — the only type whose `Adopts:` line is applied. */
const EPIC = 'epic';

/**
 * What this sweep would do to one workspace, over an index already in hand.
 *
 * `{ apply, refused }` — `apply` is `[{ epic, bead }]` in the order the writes should
 * happen, `refused` is `[{ epic, bead, why }]` where `why` is the sentence a log line
 * prints. Pure, and that is deliberate: every rule above is a case a fixture can put in
 * front of it, and a rule that can only be tested by writing to a tracker is one nobody
 * re-tests after changing it.
 *
 * An index with no `adopts` — the stand-in lib/bd.js invents when an export could not be
 * read — plans nothing, which is the right answer for "we could not look".
 */
export function adoptionPlan(index) {
  const apply = [];
  const refused = [];
  const adopts = index?.adopts;
  if (!adopts?.size) return { apply, refused };

  const beads = index?.beads || new Map();
  const edges = index?.edges || new Map();
  // A copy, written to as the plan grows, so the plan is consistent with *itself* and not
  // only with the graph it started from. Two epics adopting each other is the case: both
  // are parentless in the index, so a second pass over the untouched map would plan a
  // loop and hand bd a write it refuses — every thirty seconds, for as long as both lines
  // say what they say.
  const parents = new Map(index?.parents || []);

  // Who else claims each bead, before anything is applied. Built from the whole graph
  // rather than as the loop goes, because "the first epic exported wins" is not a rule,
  // it is the absence of one — and it would make the losing epic's refusal depend on
  // which order bd happened to write two rows in.
  const claimedBy = new Map();
  for (const [epicId, ids] of adopts) {
    if (beads.get(epicId)?.issue_type !== EPIC) continue;
    if (String(beads.get(epicId)?.status || '').toLowerCase() === 'closed') continue;
    for (const id of ids) {
      if (!claimedBy.has(id)) claimedBy.set(id, []);
      claimedBy.get(id).push(epicId);
    }
  }

  // Sorted so two machines reading the same graph plan the same writes in the same order
  // — the argument lib/homing.js makes for sorting the unsorted-backlog candidates.
  for (const epicId of [...adopts.keys()].sort()) {
    const epic = beads.get(epicId);
    // Not an epic, or not one any more: the line is prose in a task, and reparenting a
    // bead under a task is how the shape lib/homing.js warns about gets manufactured —
    // an open child of a non-P0 parent that has since closed, held forever.
    if (epic?.issue_type !== EPIC) continue;
    if (String(epic.status || '').toLowerCase() === 'closed') continue;

    for (const bead of adopts.get(epicId)) {
      const at = { epic: epicId, bead };
      const row = beads.get(bead);

      if (!row) {
        refused.push({ ...at, why: 'no bead of that id in this workspace' });
        continue;
      }
      const alsoClaimedBy = (claimedBy.get(bead) || []).filter((e) => e !== epicId);
      if (alsoClaimedBy.length) {
        refused.push({ ...at, why: `${alsoClaimedBy.join(' and ')} claims it too — which epic holds it is a decision` });
        continue;
      }
      const parent = parents.get(bead);
      if (parent === epicId) continue; // Already applied, which is the ordinary case.
      if (parent) {
        refused.push({ ...at, why: `already a child of ${parent}` });
        continue;
      }
      const edge = edges.get(pairKey(bead, epicId));
      if (edge && !RELATED_EDGES.has(edge.type)) {
        refused.push({ ...at, why: `already linked by a ${edge.type} edge, and bd allows a pair only one` });
        continue;
      }
      if (ancestorsOf(parents, epicId).includes(bead)) {
        refused.push({ ...at, why: `${epicId} is already below it, so adopting it would close a loop` });
        continue;
      }
      // The see-also the mention hook drew, to be taken off first — see the header. Carried
      // with its ends in the order bd wrote them, because that is the order `bd dep remove`
      // takes and the row may have been written from either side.
      apply.push(edge ? { ...at, drop: [edge.from, edge.to] } : at);
      parents.set(bead, epicId);
    }
  }
  return { apply, refused };
}

/**
 * The line a log prints for one refusal. One spelling, because the daemon and the tests
 * both say it and a refusal nobody can grep for is one nobody finds.
 */
export const describeRefusal = (r) => `${r.epic} cannot adopt ${r.bead}: ${r.why}`;

/**
 * Apply what is free to apply, across every workspace. Never throws.
 *
 * `{ applied, refused, failed, workspaces }`. `applied` and `refused` are the rows above;
 * `failed` is `[{ epic, bead, why }]` for a write bd rejected anyway — a lock it would not
 * give up, a rule this file does not know about — which is a refusal that costs a spawn
 * and is therefore reported separately from the ones decided on the index.
 *
 * **The graph is refreshed once per workspace that changed, at the end.** `Bd.adopt`
 * would otherwise re-export the whole workspace after each write; on an epic with a
 * twenty-three-bead list that is twenty-three exports of a graph nothing else has touched.
 *
 * `onLog` takes the sentences rather than a channel, so a test can read them and the
 * daemon can put them where its other sweeps go.
 */
export async function sweepAdoptions(bd, workspaces = [], { onLog = () => {} } = {}) {
  const out = { applied: [], refused: [], failed: [], workspaces: [] };
  for (const workspace of workspaces || []) {
    let index;
    try {
      index = await bd.graph(workspace);
    } catch (err) {
      // `Bd.graph` does not throw — it stamps a stand-in — but a caller may hand in any
      // object with a `graph`, and a sweep in the poll cycle is the wrong place to find out.
      onLog(`[adopts] could not read ${workspace?.name || 'the tracker'}: ${String(err?.message || err).split('\n')[0]}`);
      continue;
    }
    // A stand-in for a read that failed knows nothing about what is adopted, and a plan
    // built on it would be a plan built on an empty graph — every id "no bead of that id".
    if (index?.error) continue;

    const { apply, refused } = adoptionPlan(index);
    for (const r of refused) out.refused.push({ ...r, workspace: workspace?.name || '' });

    let wrote = 0;
    for (const one of apply) {
      try {
        // bd holds one edge per pair, so the see-also has to be gone before the parent
        // link will go in. A failure here is a failure of the adoption: it lands in
        // `failed` through the same catch, and the pair keeps the edge it had.
        if (one.drop) await bd.dropDep(workspace, one.drop[0], one.drop[1]);
        await bd.adopt(workspace, one.bead, one.epic, { refresh: false });
        wrote += 1;
        out.applied.push({ ...one, workspace: workspace?.name || '' });
        onLog(`[adopts] ${one.epic} adopted ${one.bead}`);
      } catch (err) {
        const why = String(err?.message || err).split('\n')[0];
        out.failed.push({ ...one, workspace: workspace?.name || '', why });
        onLog(`[adopts] ${one.epic} could not adopt ${one.bead}: ${why}`);
      }
    }
    if (wrote) await bd.graph(workspace, { refresh: true }).catch(() => {});
    out.workspaces.push({ workspace: workspace?.name || '', applied: wrote, refused: refused.length });
  }
  return out;
}
