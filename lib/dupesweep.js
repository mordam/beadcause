/**
 * The other half of bc-arj0.6 — every live near-verbatim title, joined, whoever wrote it.
 *
 * `Bd.duplicateOf` (lib/dupe.js) put the check at `Bd.create`, which covers every bead
 * beadcause itself files — a worker's discovery, an approved proposal, a console draft,
 * a JIRA epic, a crash the daemon files on itself. It cannot cover two things: a pair
 * that was already sitting on the graph unjoined before that check existed, and a
 * literal `bd create` typed into a shell, which reaches past every seam beadcause owns.
 * `bd hooks` is git hooks only — there is no pre-create hook to borrow, so a shell create
 * is invisible to anything else in this repo.
 *
 * scripts/relate-sweep.mjs is the shape this is built from: a pass over the whole graph
 * that draws an edge nobody had. That one reads bead ids already written in prose
 * (lib/mentions.js); this one has no prose to read — the tell is two titles that are
 * almost the same sentence — so it runs `titleSimilarity` (lib/dupe.js) over every live
 * pair instead.
 *
 * **Reads `Bd.graph`'s cached index, the same one `sweepAdopts` and the dispatch gate
 * keep warm.** No `bd` spawn on the steady state: `openRows` is a `Map` walk over data
 * already in hand, and the write is one `bd dep relate` per pair that clears the bar —
 * which after the first pass over a workspace is nearly always none. That is what makes
 * this affordable on the poll cycle rather than a `npm run relate`-style manual sweep:
 * the graph beadcause already reads every thirty seconds is what answers the question,
 * so the first tick after this deploys does the backfill and every tick after it is the
 * create-time net's missing half, closing within one cycle rather than within the hour
 * the bead asked for.
 *
 * **The threshold is `DUPE_THRESHOLD` unchanged, and that decision cost more than it
 * looks.** The three pairs bc-arj0.17's own description names as the motivating
 * examples — bc-297u/bc-syzm, bc-767a/bc-giuc — score 0.53 and 0.64 against each other,
 * well under the 0.9 near-verbatim bar `findDuplicate` already uses everywhere else in
 * this codebase. They are the same bug, worded differently, which is a harder problem
 * than this file solves: a word-set Dice coefficient cannot tell "the same defect,
 * described from a different angle" from "an unrelated bead that happens to share a
 * few words", and loosening the threshold on a graph of several hundred long, wordy,
 * similarly-phrased titles (this repo's own convention) would trade a sweep that misses
 * real pairs for one that wires unrelated beads together on every tick. The acceptance
 * criterion this bead was given asks for "near-verbatim titles", which is exactly what
 * `DUPE_THRESHOLD` already means here — so this stays a companion to the create-time
 * check, at the same bar, rather than a new and looser one.
 *
 * **Silent, not a card — the open question the bead left.** A resemblance is not
 * something anybody has to act on: `Bd.create`'s answer to the same question was "link
 * and say why in the bead's own notes", not "refuse" or "ask", because a duplicate is
 * evidence worth having beside the work rather than a decision blocking it. A backfilled
 * pair and one caught after the fact are the same fact — two live beads about the same
 * thing that had not found each other — and treating the second as evidence of a bypass
 * worth a card would mean every hand-typed `bd create` costs an inbox entry nobody has
 * to answer, on the one surface where noise costs the most (lib/dupe.js's own words,
 * about the sweep card and the stranded-branch finding). The edge is the whole of what
 * this writes; whoever opens either bead sees the other in `bd show`.
 */
import { openRows, titleSimilarity, DUPE_THRESHOLD } from './dupe.js';
import { pairKey } from './ancestry.js';

/** `bd create`'s own exclusion (`Bd.duplicateOf`), tested the same way it is there. */
const HUMAN_LABEL = 'human';

/**
 * Every unjoined pair of live beads whose titles clear `threshold`, pure.
 *
 * `index` is a `Bd.graph` shape: `{ beads, edges }` is all that is read. `openRows`
 * already drops anything not `open`, `in_progress` or `blocked` — a bead whose work has
 * landed is what a follow-up is a follow-up *to*, not a duplicate of, the same call
 * lib/dupe.js makes for the create-time net.
 *
 * **Questions are skipped on both sides.** A `human` bead's title is formulaic by
 * construction — the sweep card, the stranded-branch finding, the merge card — and each
 * of those already refuses to file its own twin, so two of them landing near-identical
 * is the mechanism working rather than two duplicates found late. `Bd.duplicateOf`
 * excludes it only on the side of the bead being filed, because there the candidate side
 * is real work worth knowing about; here both sides are already-filed beads and the same
 * formulaic-title argument applies to either one.
 *
 * Sorted by id before comparing, so two machines reading the same graph plan the same
 * pairs in the same order — `lib/adoptsweep.js`'s argument, for the same reason: a test
 * asserting *which* pair a three-way near-tie names should not depend on `Map` iteration
 * order.
 */
export function duplicatePlan(index, { threshold = DUPE_THRESHOLD } = {}) {
  const edges = index?.edges || new Map();
  const rows = openRows(index)
    .filter((r) => !(r.labels || []).includes(HUMAN_LABEL))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const apply = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (edges.has(pairKey(a.id, b.id))) continue;
      const score = titleSimilarity(a.title, b.title);
      if (score < threshold) continue;
      apply.push({ a: a.id, b: b.id, score, titleA: a.title, titleB: b.title });
    }
  }
  return apply;
}

/**
 * Apply what `duplicatePlan` finds, across every workspace. Never throws.
 *
 * `{ applied, failed, workspaces }` — `applied` and `failed` are `duplicatePlan`'s rows
 * with `workspace` and, on `failed`, `why` added; `workspaces` is one summary row per
 * workspace swept, for a log line that says something even on a tick that wrote nothing.
 *
 * A stale or unread graph plans nothing rather than an empty one being mistaken for
 * "nothing to join" — same two guards as `sweepAdoptions`, and the same reason: a plan
 * built on a stand-in would report every pair on the graph as unjoined.
 *
 * `onLog` takes the sentence rather than a channel, so a test can read it and the daemon
 * can put it where `sweepAdopts` puts its own.
 */
export async function sweepDuplicates(bd, workspaces = [], { onLog = () => {} } = {}) {
  const out = { applied: [], failed: [], workspaces: [] };
  for (const workspace of workspaces || []) {
    let index;
    try {
      index = await bd.graph(workspace);
    } catch (err) {
      onLog(`[dupes] could not read ${workspace?.name || 'the tracker'}: ${String(err?.message || err).split('\n')[0]}`);
      continue;
    }
    if (index?.error) {
      onLog(`[dupes] not sweeping ${workspace?.name || 'the tracker'}: its shape has never been read — ${index.error}`);
      continue;
    }
    if (index?.stale) {
      onLog(
        `[dupes] not sweeping ${workspace?.name || 'the tracker'}: its shape could not be re-read, and the last one predates what is being asked about — ${index.stale}`
      );
      continue;
    }

    const plan = duplicatePlan(index);
    let wrote = 0;
    for (const pair of plan) {
      try {
        await bd.run(workspace, ['dep', 'relate', pair.a, pair.b], { retries: 3 });
        wrote += 1;
        out.applied.push({ ...pair, workspace: workspace?.name || '' });
        onLog(`[dupes] ${pair.a} ↔ ${pair.b} linked as near-verbatim (${pair.score.toFixed(2)})`);
      } catch (err) {
        const why = String(err?.message || err).split('\n')[0];
        out.failed.push({ ...pair, workspace: workspace?.name || '', why });
        onLog(`[dupes] ${pair.a} ↔ ${pair.b} could not be linked: ${why}`);
      }
    }
    if (wrote) await bd.graph(workspace, { refresh: true }).catch(() => {});
    out.workspaces.push({ workspace: workspace?.name || '', applied: wrote });
  }
  return out;
}
