import { parseProposal } from './proposal.js';

/**
 * Has this already been filed?
 *
 * The failure this exists for: bc-j6x and bc-ec6 were the same bug, proposed twice on
 * the same day, both approved, both opened. The second worker found the fix already
 * committed on the first one's branch and had to stop — one wasted window, one wasted
 * approval tap, and a near-miss on two conflicting pull requests against the same
 * lines. The titles were not merely similar; they were **byte-identical**.
 *
 * The advocate was already told not to do this. lib/advocate.js's survey prompt says to
 * skip "anything already covered by an open bead — check `bd list --status=open` before
 * you propose". It proposed anyway, which is the whole lesson: a prompt is a request,
 * and a request loses. So the check moved here, into the path a proposal has to travel
 * whoever wrote it, and it runs twice —
 *
 *   - **When the proposal is written** (lib/advocate.js, bin/propose.js), so the card
 *     that reaches the phone carries "this looks like bc-ec6, already open" beside the
 *     row. That is the point of it: an approve tap that knows what it is approving.
 *   - **When the proposal is approved** (lib/server.js), because the duplicate may have
 *     appeared *after* the card was written — which is precisely the bc-j6x timeline.
 *     A duplicate nobody was shown is not something a tap consented to, so that one is
 *     refused rather than flagged, and said out loud on the thread.
 *
 * Nothing here writes, asks bd anything, or knows what a workspace is: it is titles in,
 * verdict out. The callers own the lookup, because each of them already has the rows
 * for another reason.
 */

/**
 * A title reduced to the words in it.
 *
 * Case, punctuation and possessives all go, because "The advocate's allowlist still has
 * Bash(bd *)" and "The advocate's allowlist still has `Bash(bd *)`" are one title typed
 * twice. Apostrophes are dropped rather than turned into a space so `advocate's` reads
 * as `advocates` and matches itself written either way.
 */
export function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = (text) => {
  const norm = normalizeTitle(text);
  return norm ? new Set(norm.split(' ')) : new Set();
};

/**
 * How alike two titles are, 0 to 1: the Dice coefficient over their word sets.
 *
 * Word sets and not edit distance, because the rewrites that matter here are
 * word-level — a dropped "the", a `bd` in backticks, "still has" for "has" — and edit
 * distance scores a one-word insertion the same as a changed meaning. Deliberately
 * blind to word order, which errs toward flagging; at proposal time flagging costs a
 * line on a card, and at approval time the flag is checked against what the card
 * actually said before it can refuse anything.
 */
export function titleSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/**
 * How alike is "the same bead, proposed twice".
 *
 * 0.9 is near-verbatim and nothing looser, and the number is chosen off a real pair
 * rather than by feel. "The router never proxies a WebSocket **upgrade**" and "…a
 * WebSocket **downgrade**" are opposite beads sharing six of seven words: they score
 * 0.86, and merging them would refuse a genuine bead. So a short title has to match
 * word for word; a long one tolerates a word of drift — the fourteen-word title bc-j6x
 * and bc-ec6 shared scores 0.97 with an extra word in it, which is the case this is for.
 */
export const DUPE_THRESHOLD = 0.9;

/**
 * The live bead a proposed title is a duplicate of, or null.
 *
 * `beads` is whatever the caller has: `{ id, title, status }` is all that is read.
 * Highest score wins, and ties break toward the row that came first — `bd list` returns
 * them oldest-first, so the bead that has been open longest is the one named, which is
 * also the one whose work is furthest along.
 */
export function findDuplicate(title, beads, { threshold = DUPE_THRESHOLD, ignore = [] } = {}) {
  const skip = new Set((ignore || []).filter(Boolean));
  let best = null;
  for (const b of beads || []) {
    if (!b || !b.title || skip.has(b.id)) continue;
    const score = titleSimilarity(title, b.title);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { id: b.id, title: b.title, status: b.status || 'open', score };
  }
  return best;
}

/**
 * The same proposal, with `duplicate` set on any row that already exists.
 *
 * Returns new objects rather than mutating: the beads it is handed came out of
 * `parseProposal`, and the caller renders both the markdown body and the YAML block
 * from the result — see `strip` in lib/proposal.js, which is what carries the flag
 * through the stored bead and back out to the phone.
 *
 * Rows are compared against each other too, in the order they were proposed. One
 * survey returning the same bead twice is rarer than two surveys doing it, but it is
 * the same waste and the same fix, and a proposal is the one place where the comparison
 * costs nothing at all.
 */
export function annotateDuplicates(beads, live, opts = {}) {
  const earlier = [];
  return (beads || []).map((b, i) => {
    const hit = findDuplicate(b.title, [...(live || []), ...earlier], opts);
    // Numbered from 1 like every other view of a proposal, so "already proposed as 2"
    // names the row you are looking at rather than an index nobody can see.
    earlier.push({ id: `#${i + 1}`, title: b.title, status: 'proposed' });
    return { ...b, duplicate: hit ? { id: hit.id, title: hit.title, status: hit.status } : null };
  });
}

/**
 * The titles an open proposal is *asking* to create, as duplicate candidates.
 *
 * A pending proposal is not a bead, so it is in nothing bd would call open — and that
 * is exactly what bc-j6x and bc-ec6 were for most of the day they collided. Their own
 * titles are no use ("Create a bead in beadcause: …" is synthesised), so the
 * `beadproposal` block is read back out of each one and every bead it names becomes a
 * candidate, attributed to the question you would go and answer.
 *
 * `status: 'proposed'` rather than 'open', because the card says what state the thing
 * it found is in, and a proposal is not open — it is waiting on the same person who is
 * now being asked a second time.
 */
export function pendingProposedTitles(rows, { ignore = [] } = {}) {
  const skip = new Set((ignore || []).filter(Boolean));
  const out = [];
  for (const row of rows || []) {
    if (!row || skip.has(row.id)) continue;
    const source = [row.description, row.design, row.notes].filter(Boolean).join('\n\n');
    let parsed = null;
    try {
      parsed = parseProposal(source);
    } catch {
      continue; // A proposal we cannot read is not a proposal we can dedupe against.
    }
    if (!parsed || parsed.error) continue;
    for (const b of parsed.beads) out.push({ id: row.id, title: b.title, status: 'proposed' });
  }
  return out;
}

/**
 * Everything a proposed title could already be, out of one `bd list` of the live set.
 *
 * The live set is passed in whole — `open,in_progress,blocked`, questions included —
 * and split here, because the two halves are compared differently and asking bd twice
 * for the same rows would be a second call on a path that runs on every proposal:
 *
 *   - **A proposal question** is not a bead. Its own title is synthesised
 *     ("Create a bead in beadcause: …") and would match any bead it names, so it is
 *     read for the titles it *asks* for instead.
 *   - **Everything else** is a bead somebody may already be working, compared on its
 *     own title.
 *
 * `ignore` drops rows by id: at approval time that is the question being answered,
 * whose own proposed titles are the very thing being created.
 */
export function liveCandidates(rows, { ignore = [], proposalLabel = 'advocate-proposal', pending = true } = {}) {
  const skip = new Set((ignore || []).filter(Boolean));
  const beads = [];
  const proposals = [];
  for (const row of rows || []) {
    if (!row || skip.has(row.id)) continue;
    if ((row.labels || []).includes(proposalLabel)) proposals.push(row);
    else beads.push({ id: row.id, title: row.title, status: row.status || 'open' });
  }
  return pending ? [...beads, ...pendingProposedTitles(proposals)] : beads;
}
