/**
 * What is under what — the parent map, and the one question the epic board asks of it.
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

// Leaves like this file, all three, and every one of them for the same reason: the fact
// is read out of the rows the parent map is already built from, because the alternative
// is a second `bd export` per sweep for text this pass had in its hand. See `indexFrom`.
import { adoptedBy } from './adopts.js';
import { isRoot } from './ownership.js';
import { relayMark } from './relayjournal.js';

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
 * The pair two beads make, whichever way round they were written.
 *
 * bd holds **one edge per pair, of any type, in either direction** — measured against
 * the real binary in test/epicedgereal.mjs, and the whole reason lib/adoptsweep.js has
 * to look before it writes: `bd update <bead> --parent=<epic>` is refused outright by a
 * `discovered-from` edge somebody's `bin/file.js --from` left behind. So the key is
 * sorted: the edge exists between them, not from one to the other.
 */
export const pairKey = (a, b) => [String(a || ''), String(b || '')].sort().join('~');

/**
 * The same one pass, giving back every half of what the export is worth reading for.
 *
 * `{ parents, beads, adopts, edges }`, where `beads` is `Map(id → { id, title, status,
 * priority, issue_type, assignee, labels, notes })` — the fields the P0 section draws and
 * the ownership filter reads, and nothing else, because the export carries whole
 * descriptions and holding 700 of those in a cache for a minute is a cost with no
 * reader.
 *
 * **One read answers four questions, and that is the point.** The epic board needs to know
 * which beads carry `owner:<handle>` at priority 0 as well as what is under what, and
 * asking `bd list -p 0 -l owner:…` per workspace would be a second spawn per sweep — on
 * this Mac, under the load an ordinary afternoon puts on a single-writer Dolt, a second
 * six seconds. The export already has every row and every parent edge in it; splitting
 * that into two commands would be paying twice for one answer.
 *
 * `adopts` and `edges` are the same argument made twice more, for bc-arj0.2:
 *
 * - **`adopts` is `Map(epicId → [ids])`** — the `Adopts:` line parsed, and *only its
 *   answer kept*. The line lives in a description, and the reason this file has never
 *   carried descriptions is that seven hundred of them in a cache for a minute is a cost
 *   with no reader; a list of four ids is not that. The alternative was a second `bd
 *   export` per sweep to read text this pass already had, which on the measurement above
 *   is a whole extra second per workspace per tick. Absent where the list is empty, which
 *   is almost every bead.
 * - **`edges` is `Map(pairKey → { type, from, to })`** — every dependency row, not just
 *   the parent ones, because the one-edge rule above is what decides whether an adoption
 *   *can* be applied at all, and finding out by attempting the write costs a doomed `bd`
 *   spawn every thirty seconds for as long as the line says what it says. The direction
 *   is kept as well as the type: `bd dep remove` takes the ends in the order they were
 *   written, and lib/adoptsweep.js does remove one of them.
 */
export function indexFrom(jsonl) {
  const parents = new Map();
  const beads = new Map();
  const adopts = new Map();
  const edges = new Map();
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
        // Who is on it, for the one row that draws it: a bead in a P0's tree says whose
        // it is, and the export already carries it. `assignee` and not `owner`, because
        // `owner` is a fact about the git identity that created the bead — 633 of the 822
        // records here carry the same one — where `assignee` is what a claim writes, which
        // is the question a row in a tree is actually asking. It is also not the `owner:`
        // *label* the board filters on (lib/ownership.js); those are a third thing again.
        assignee: row.assignee || '',
        labels: Array.isArray(row.labels) ? row.labels : [],
        // Notes, and **only on a root**. The card draws one sentence out of them (the
        // advocate's "what is this waiting on" block, lib/epicadvocate.js) and nothing
        // else here reads them — so carrying every bead's notes would hold 700 bodies of
        // prose in a cache for a minute to answer a question about a dozen rows.
        //
        // **`isRoot` and not `isP0` since bc-htoy**, and this line is where that widening
        // would otherwise have failed quietly rather than loudly. An epic at P2 now gets a
        // card and an advocate, and the advocate's whole re-entrant contract is that what
        // it concluded is on the bead — but the card is drawn off *this* index, so a P0-only
        // notes field would have handed `waitingOn` an empty string and drawn the card one
        // line short. Not an error anywhere: just an advocate that appears never to have
        // looked, which is the exact state the sentence exists to distinguish from.
        notes: isRoot(row) ? row.notes || '' : '',
        // Where a department relay on this bead has got to — parsed here rather than kept
        // as text, which is what makes it affordable on a *leaf* where the notes above are
        // not (bc-bmry.4). The line above is right that 700 bodies of prose have no
        // business in a cache; a relay mark is six short fields and `null` on every bead no
        // relay has ever run on, which is all but a handful in one workspace. Parsing costs
        // one `indexOf` per row against text already in hand.
        //
        // Every bead and not just a root, which is the whole point: a relay runs on the
        // *leaves*, and the surface that draws this is the tree on an epic's card. Reading
        // it off `notes` there would have answered `null` for ever, silently, because the
        // line above blanks that field for everything but a root.
        relay: relayMark(row),
      });
      // The parsed answer and not the text it came from — see the header. `adoptedBy`
      // reads four fields and drops the epic's own id, so what lands here is already the
      // set the close gate in lib/bd.js is holding the epic open over: one parser, and
      // the gate and the applier cannot come to disagree about what the line says.
      const claimed = adoptedBy(row);
      if (claimed.length) adopts.set(id, claimed);
    }
    for (const dep of Array.isArray(row?.dependencies) ? row.dependencies : []) {
      const from = String(dep?.issue_id || '').trim();
      const to = String(dep?.depends_on_id || '').trim();
      if (!from || !to || from === to) continue;
      // Every type, keyed by the unordered pair, because bd's refusal is about the pair
      // rather than about the direction or the type. A pair carrying two rows cannot
      // happen through bd; the last one wins, for the reason a second parent does.
      edges.set(pairKey(from, to), { type: String(dep.type || ''), from, to });
      if (dep.type !== PARENT_EDGE) continue;
      parents.set(from, to);
    }
  }
  return { parents, beads, adopts, edges };
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

/**
 * The map the other way round — `Map(parentId → [childId, …])`.
 *
 * Built once per workspace and handed to `treeUnder` for each of its P0s, which is the
 * whole reason it is its own function: the export gives child → parent, and a board with
 * a dozen P0s over 800 beads that inverted it per card would rebuild the same index a
 * dozen times. Walking upwards, the way `underAnyOf` does, is the right shape for *one*
 * bead's question and the wrong shape for "everything below this" — that is a pass over
 * every bead in the workspace per root, where this is one pass, ever.
 *
 * Order is the export's order, and nothing should rely on it; `treeUnder` sorts.
 */
export function childrenFrom(parents) {
  const kids = new Map();
  for (const [child, parent] of parents || []) {
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }
  return kids;
}

/**
 * Children, in the order a person reads them: what is left, then what is finished.
 *
 * Ids are compared numerically rather than as text, because bd's own are `bc-goo.1`
 * through `bc-goo.10` and a plain string sort files the tenth child between the first and
 * the second. `Bd.listChildren` sorts its rows with this too — it is the same question
 * about the same tracker, and two comparators would eventually disagree about where the
 * same bead goes on two screens.
 */
export const byDoneThenId = (a, b) =>
  Number(a.status === 'closed') - Number(b.status === 'closed') ||
  String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/**
 * Everything under `root`, at any depth, as a flat array the client can nest in one pass.
 *
 * bc-rfnr.9.1. The board used to answer with `under` alone — one string per *inbox row*
 * saying which P0 it hangs off — and that is a map with a hole in it exactly where the
 * feature is: a bead nobody is being asked about has no inbox row, so it was in no map at
 * all, and a card that wants to draw its own tree cannot draw the two thirds of it that
 * is quiet. `under` answers "should this row be on screen"; this answers "what is under
 * this P0", and only the second one can be a board.
 *
 * **Flat, in pre-order, with a `parent` and a `depth` on every row.** A parent always
 * appears before its children, so a client nests it with one loop and a map of id → node
 * and never walks anything; and `depth` alone is enough to indent the whole thing without
 * nesting at all. The alternative — real nested objects — costs a recursive renderer on a
 * phone and cannot be reconciled by key, which is how every other list in this app
 * repaints.
 *
 * **A row is dropped if `beads` has never heard of it, and its subtree with it.** That
 * happens when an export names a parent edge for an id whose own record did not parse, or
 * was written by an import that rewrote ids, and the two honest choices are to drop the
 * branch or to invent a row for it. Dropping keeps the one promise the shape makes —
 * every row's `parent` is the root or a row earlier in the same array — where an invented
 * row would draw a bead with no title, no status and a link to nothing.
 *
 * **Closed descendants are here.** The card's counts are of what is *left*, but the tree
 * is the board, and a status filter over it (bc-rfnr.9.6) can only default to not-closed
 * if the closed ones were sent. Measured on this tracker, 2026-08-13: the largest P0 has
 * 31 descendants and its entire tree is 3.3KB of JSON.
 *
 * Cycle-safe for the reason `ancestorsOf` is — an import that rewrote ids can write one,
 * and a daemon that hangs drawing the inbox is the failure this app exists to prevent.
 * The seen-set also means a bead appears exactly once, under whichever parent the walk
 * reached first.
 */
export function treeUnder(children, beads, root) {
  const from = String(root || '');
  if (!from) return [];
  const out = [];
  const seen = new Set([from]);
  const walk = (parent, depth) => {
    const kids = (children?.get?.(parent) || [])
      .filter((id) => !seen.has(id) && beads?.has?.(id))
      .map((id) => beads.get(id))
      .sort(byDoneThenId);
    for (const b of kids) {
      seen.add(b.id);
      out.push({
        id: b.id,
        title: b.title || '',
        issue_type: b.issue_type || '',
        status: b.status || 'open',
        priority: b.priority ?? null,
        assignee: b.assignee || '',
        parent,
        depth,
      });
      walk(b.id, depth + 1);
    }
  };
  walk(from, 1);
  return out;
}
