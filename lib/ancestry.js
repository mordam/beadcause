/**
 * What is under what — the parent map, and the one question the P0 board asks of it.
 *
 * bc-rfnr.2 needs to draw a list containing nothing that does not descend from one of
 * your P0s. That is a question about ancestry, and the surprising part is that the
 * tracker will not answer it cheaply in any of the three obvious ways:
 *
 * - **`bd list --json` does not carry a parent.** Not in tree mode either — the rows are
 *   `id, title, …, dependency_count, dependent_count` and nothing else, so the JSON the
 *   whole sweep is already built on cannot be walked upwards. `bd show` does carry
 *   `parent`, which would be one spawn per bead: 132 of them on the current tracker.
 * - **Hierarchical ids are a lie you get away with.** `bc-rfnr.1` is under `bc-rfnr`
 *   almost always — but `bd update --parent` does not renumber, so a bead moved under
 *   another epic keeps an id pointing at the epic it left, and a bead reparented *into*
 *   one keeps a flat id. Both errors are silent and both are in the direction that
 *   matters: a bead drawn under a P0 it no longer belongs to, or hidden from the one it
 *   does.
 * - **`bd list --parent <id>`, walked downwards, is one spawn per node.** Measured on
 *   this Mac on an ordinary afternoon: **6.4 seconds** for a single call, because ~20
 *   agent sessions share the workspace and embedded Dolt is single-writer. Fifty of
 *   those is five minutes, for a filter that has to survive a 25-second repaint.
 *
 * **So the source is `bd export`.** One spawn, ~1.3s over 711 records, and it carries the
 * edges as data: every parent link is a dependency row of `type: "parent-child"`, which
 * is also the only way to get this right — `blocks`, `discovered-from`, `supersedes` and
 * `related` come back in the same array, and bc-rfnr.2 is explicit that a dependency edge
 * or a discovered-from link must **not** pull a bead into the list. A walk that treated
 * every edge as an edge would quietly re-admit most of the backlog through the
 * `discovered-from` trail that lib/filing.js puts on everything an agent files.
 *
 * Nothing here spawns anything. This file is the parsing and the walking — a map in, an
 * answer out — so a test can assert the whole of the interesting behaviour (a cycle, a
 * reparented child, an orphan pointing at a bead that has been deleted) without a
 * tracker. `Bd.parents` is the eight lines that run the command; the cache is there too,
 * because that is where the workspace and the clock are.
 */

/** bd's word for a parent link, and the only edge type that is one. */
export const PARENT_EDGE = 'parent-child';

/**
 * `bd export` JSONL → `Map(childId → parentId)`.
 *
 * Takes the text rather than a path, for the reason the rest of this file takes plain
 * data: the caller that has a `bd` to spawn is not the caller that knows what a parent
 * edge looks like.
 *
 * **A malformed line is skipped, not thrown.** An export is 700 records and one of them
 * being unreadable is not a reason to draw an inbox with no P0 section — that failure
 * mode is the screen this app exists never to show, so the map comes back with the 699
 * that parsed. A line with no `dependencies` is an ordinary root and contributes nothing.
 *
 * **A second parent overwrites the first**, which cannot happen through `bd` and is
 * therefore not worth a policy: bd's own `--parent` is a single value, and the map is
 * built from whatever the last row said rather than pretending to resolve a conflict the
 * tracker cannot express.
 */
export function parentsFrom(jsonl) {
  return indexFrom(jsonl).parents;
}

/**
 * The same one pass, giving back both halves of what the export is worth reading for.
 *
 * `{ parents, beads }`, where `beads` is `Map(id → { id, title, status, priority,
 * labels })` — the fields the P0 section draws and the ownership filter reads, and
 * nothing else, because the export carries whole descriptions and holding 700 of those
 * in a cache for a minute is a cost with no reader.
 *
 * **One read answers two questions, and that is the point.** The P0 board needs to know
 * which beads carry `owner:<handle>` at priority 0 as well as what is under what, and
 * asking `bd list -p 0 -l owner:…` per workspace would be a second spawn per sweep — on
 * this Mac, under the load an ordinary afternoon puts on a single-writer Dolt, a second
 * six seconds. The export already has every row and every parent edge in it; splitting
 * that into two commands would be paying twice for one answer.
 */
export function indexFrom(jsonl) {
  const parents = new Map();
  const beads = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      continue;
    }
    const id = String(row?.id || '').trim();
    if (id) {
      beads.set(id, {
        id,
        title: row.title || '',
        status: row.status || 'open',
        priority: row.priority ?? null,
        issue_type: row.issue_type || '',
        labels: Array.isArray(row.labels) ? row.labels : [],
        // Notes, and **only on a P0**. The P0 card draws one sentence out of them (the
        // advocate's "what is this waiting on" block, lib/epicadvocate.js) and nothing
        // else here reads them — so carrying every bead's notes would hold 700 bodies of
        // prose in a cache for a minute to answer a question about a dozen rows.
        notes: Number(row.priority) === 0 ? row.notes || '' : '',
      });
    }
    for (const dep of Array.isArray(row?.dependencies) ? row.dependencies : []) {
      if (dep?.type !== PARENT_EDGE) continue;
      const child = String(dep.issue_id || '').trim();
      const parent = String(dep.depends_on_id || '').trim();
      if (child && parent && child !== parent) parents.set(child, parent);
    }
  }
  return { parents, beads };
}

/**
 * Every ancestor of a bead, nearest first. `[]` for a root.
 *
 * **Cycle-safe, and not as a formality.** bd will not let you parent a bead to its own
 * descendant, but this map is assembled from an export that may have been written by
 * another machine, another version, or an import that rewrote ids (the runbook in
 * CLAUDE.md does exactly that when a graph moves between workspaces). An unguarded walk
 * meets a cycle by hanging the daemon, and a daemon that hangs while drawing the inbox
 * is a phone that never shows you the question — so the seen-set is the difference
 * between a wrong answer and no answer at all, and a wrong answer is much the better of
 * the two here.
 *
 * A parent that is not itself in the map simply ends the walk: it is either a root, or a
 * bead that has been deleted out from under its children, and both are ancestors that
 * exist as far as this question goes.
 */
export function ancestorsOf(parents, id) {
  const out = [];
  const seen = new Set([String(id || '')]);
  let at = parents?.get?.(String(id || ''));
  while (at && !seen.has(at)) {
    out.push(at);
    seen.add(at);
    at = parents.get(at);
  }
  return out;
}

/**
 * Does this bead have one of `roots` above it? The whole of the inbox's filter, and of
 * the dispatch gate bc-rfnr.7 puts in front of the launcher.
 *
 * **A root is under itself.** A P0 passes its own test, which is what makes one predicate
 * serve both callers: the inbox draws the P0 as a card and its descendants as the list,
 * and the gate has to let the P0 itself be worked. Spelling that as `roots.has(id) ||
 * hasAncestorIn(...)` at two call sites is two places for the P0 itself to go missing.
 */
export function underAnyOf(parents, id, roots) {
  const key = String(id || '');
  if (!key || !roots?.size) return false;
  if (roots.has(key)) return true;
  return ancestorsOf(parents, key).some((a) => roots.has(a));
}

/**
 * Everything under `roots`, roots included — the set form, for a caller that is asking
 * about a whole list rather than about one bead.
 *
 * Built by walking each bead upwards rather than each root downwards, because the map is
 * keyed child → parent and inverting it would be a second index to keep honest. Over 700
 * records with a depth of two or three this is not a cost worth optimising; over a
 * pathological depth the seen-set in `ancestorsOf` is what bounds it.
 */
export function descendantsOf(parents, ids, roots) {
  const out = new Set();
  for (const id of ids || []) {
    if (underAnyOf(parents, id, roots)) out.add(String(id));
  }
  return out;
}
