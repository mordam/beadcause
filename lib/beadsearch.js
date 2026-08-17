/*
  Matching a typed fragment against the beads a workspace holds — and the order to
  offer them in.

  ## Why this is not a `bd` call

  The inbox's bead-search box drops a list down as you type, which is one request per
  keystroke unless something stops it. `bd export` is the only command that carries the
  whole graph, and it was measured at 7.3 seconds across the nine workspaces configured
  on this Mac (see the note on `Bd.graph`) — so a search that spawned one would have made
  the box unusable and taken a P0's page budget with it.

  What it searches instead is the shape `Bd.graph` already keeps: one export per
  workspace, cached for a minute, warmed by the inbox's own epic board on every load. By
  the time anybody has typed a letter into the box the graph is in hand, and the search
  is a pass over an array in memory.

  That is also why this file exists at all rather than a filter inlined in the route: the
  ranking below is the whole of what makes the box feel like it knows the tracker, and it
  is worth a test that does not need a server.

  ## The ranking

  Four tiers, and the order is the order somebody typing would expect:

  1. **The id, exactly — with or without the tracker's prefix.** Typing `bc-0xil` in full
     is asking for one bead, and so is typing `0xil`: nobody types `bc-` when every bead
     on the screen begins with it. Without that second half the bead you named sorts
     *below its own children*, because `rfnr` merely "appears in" `bc-rfnr` the same way
     it appears in `bc-rfnr.9.2` — which is how this was found.
  2. **The id, from the start**, prefix optional again. `bc-0x` is how you narrow towards
     one; `bc-0xil.3` is a child, and children belong under their parent rather than
     scattered through the titles.
  3. **The id, anywhere.** A fragment from the middle — which is what is left once both
     ends have been asked.
  4. **The title.** bc-s557 asked whether titles should match at all, given that the spec
     said `beadIds` three times. They do, because the dropdown shows the title beside
     every id either way, and a box that displays a title and then refuses to match it
     reads as broken rather than as scoped. An id-only search is one line from here if
     that answer comes back the other way.

  Within a tier, open beads before closed ones and then by id, numerically — `bc-goo.10`
  after `bc-goo.2` rather than between `.1` and `.2`, the same comparator the rest of the
  tracker sorts children with (lib/ancestry.js `byDoneThenId`).

  **Closed beads are offered.** The point of the box is to reach a bead, and half the
  reason to reach one is to read what happened to it. They sort below the open ones, and
  every row says which it is, so the list never has to pretend a finished bead is live.
*/
import { byDoneThenId } from './ancestry.js';

/** How many suggestions the dropdown gets. A phone panel holds about this many. */
export const SEARCH_LIMIT = 12;

/**
 * Which tier a bead lands in, or `null` for no match at all.
 *
 * Lower is better, and the numbers are only ever compared — nothing outside this file
 * reads them.
 */
function tierOf(bead, needle) {
  const id = String(bead?.id || '').toLowerCase();
  if (!id) return null;
  // The id without its tracker prefix — `rfnr.9.2` out of `bc-rfnr.9.2`. Every bead on
  // one tracker carries the same prefix, so typing it is typing nothing, and everybody
  // drops it. The first dash and not the last: `.` separates children, `-` does not.
  const local = id.slice(id.indexOf('-') + 1);
  if (id === needle || local === needle) return 0;
  if (id.startsWith(needle) || local.startsWith(needle)) return 1;
  if (id.includes(needle)) return 2;
  if (String(bead?.title || '').toLowerCase().includes(needle)) return 3;
  return null;
}

/**
 * The beads a typed fragment should offer, best first.
 *
 * `beads` is anything iterable of `{ id, title, status }` — in practice the values of
 * `Bd.graph`'s `beads` map, from one or several workspaces at once. Each row is copied
 * rather than passed through, so what reaches the phone is four fields and not whatever
 * else the export happened to carry.
 *
 * **A blank query matches nothing, deliberately.** An empty box has not asked a
 * question, and answering it with the first twelve beads of the tracker would put a
 * dropdown over the list every time the field took focus.
 *
 * **One character is enough.** `9` is a legitimate thing to type when you know the bead
 * is `bc-rfnr.9`, and a minimum length would have been the control second-guessing
 * something it can answer in a millisecond.
 */
export function searchBeads(beads, query, { limit = SEARCH_LIMIT } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const bead of beads || []) {
    const tier = tierOf(bead, needle);
    if (tier == null) continue;
    hits.push({
      tier,
      bead: {
        id: String(bead.id),
        title: String(bead.title || ''),
        status: String(bead.status || 'open'),
        // Which tracker it came out of. Two workspaces can hold the same bead id — the
        // prefixes make that unlikely rather than impossible — and the client keys
        // everything by `workspace/id`, so a suggestion without one could not be picked.
        workspace: String(bead.workspace || ''),
      },
    });
  }
  hits.sort((a, b) => a.tier - b.tier || byDoneThenId(a.bead, b.bead));
  return hits.slice(0, Math.max(0, limit)).map((h) => ({ ...h.bead, key: `${h.bead.workspace}/${h.bead.id}` }));
}
