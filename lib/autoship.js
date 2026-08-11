/**
 * Who decides that a merge deploys itself — the space, or the epic above the work.
 *
 * The space answer is `autoShipAllowed` in lib/spaces.js and it is one answer for six
 * repos. That is the right grain for "this is my side project, land it and ship it" and
 * the wrong grain for the thing that actually happens inside a space: one epic is a
 * rewrite of the storage layer and one is a copy change, and they want opposite answers
 * on the same repo in the same week. Waiting for a taste-based judgement to be expressed
 * as a repo-wide toggle is how a risky migration gets shipped at 3am because the space
 * it lives in is usually safe.
 *
 * So an epic may override its space, in **either** direction — hold its work back on a
 * space that ships, ship on a space that does not — and the merge finds it by walking up
 * from the bead it delivered.
 *
 * ## An opinion is a label
 *
 * `auto-ship` and `no-auto-ship`, for the reasons lib/endorse.js gives about `unendorsed`
 * and then one more. A label is the only thing `bd` can carry, filter and show today
 * without a release; it is one word to add from a phone or a terminal; and — the extra
 * reason — it is *visible on the bead you are looking at*, which a setting buried in a
 * config file three directories away is not. Someone reading the epic can see that its
 * work ships itself.
 *
 * Both labels at once is a bead that says two things, and it resolves to `false`. That is
 * not a coin toss: one of the two answers restarts a server unattended and the other one
 * waits for a tap, and a contradiction should land on the side that waits.
 *
 * ## Nearest ancestor wins, and the walk starts at the bead itself
 *
 * `bd show --json` carries `parent`, so the chain is a lookup per level and no more. The
 * first bead in it with an opinion is the answer, and the walk stops there — a leaf that
 * says `no-auto-ship` under an epic that says `auto-ship` is a deliberate exception to a
 * deliberate rule, and the more specific of the two is the one that was written about
 * *this* work.
 *
 * The walk includes the bead itself rather than starting at its parent. The bead is the
 * nearest thing there is to the merge, and a rule that ignored what is written on it
 * would make "hold this one back" the only setting here you cannot express.
 *
 * ## Not knowing is not a no, and it is certainly not a yes
 *
 * Every failure mode in this file returns `known: false` and the caller does nothing at
 * all this tick — it does not fall through to the space. A tracker mid-write is the
 * ordinary case (Dolt is single-writer and six sessions share it), and the two ways to
 * be wrong about it are not symmetrical: falling through to a space that says yes would
 * deploy on the strength of a question nobody answered, and the next sweep five minutes
 * later asks again for free.
 */

import { autoShipAllowed } from './spaces.js';

/** This epic's work ships itself. */
export const AUTO_SHIP_LABEL = 'auto-ship';
/** …and this one holds it back, whatever the space says. */
export const NO_AUTO_SHIP_LABEL = 'no-auto-ship';

/**
 * How far up a chain to walk before giving up.
 *
 * beads nests two or three deep in practice (`bc-3zo9` → `bc-3zo9.1`), so this is not a
 * limit anything real meets — it is the guard against a `parent` cycle turning a sweep
 * into an infinite loop of `bd show`. The `seen` set below would catch a cycle too; this
 * catches the pathological-but-acyclic chain as well, and costs nothing.
 */
const MAX_DEPTH = 8;

/**
 * The opinion one bead states — `true`, `false`, or `null` for "says nothing".
 *
 * Takes a `bd --json` row, or anything with `labels`, exactly like `isHeld`.
 */
export function opinionOf(bead) {
  const labels = (bead?.labels || []).map((l) => String(l).trim());
  const yes = labels.includes(AUTO_SHIP_LABEL);
  const no = labels.includes(NO_AUTO_SHIP_LABEL);
  // Contradiction lands on the side that waits for a tap. See the header.
  if (no) return false;
  if (yes) return true;
  return null;
}

/**
 * Walk one bead and its ancestors for the nearest opinion.
 *
 * `{ value, from }` for an answer, `null` for a chain that states none, and it *throws*
 * for a tracker that could not be read — which the caller turns into `known: false`. The
 * two are deliberately different: "nobody said anything" is a fact about the beads and
 * falls through to the space, "I could not ask" is a fact about this tick and falls
 * through to nothing.
 *
 * `seen` is the caller's memo across a whole sweep. Four merges under one epic is the
 * ordinary shape of a busy morning, and each of them walks through the same two beads.
 */
export async function opinionAbove(bd, ws, id, { seen = new Map() } = {}) {
  const visited = new Set();
  let at = String(id || '');
  for (let depth = 0; at && depth < MAX_DEPTH; depth += 1) {
    if (visited.has(at)) return null;
    visited.add(at);

    const key = `${ws.name}/${at}`;
    // The promise, not the answer, for the reason lib/beadref.js memoises the same way:
    // concurrent rows reach this within a tick of each other.
    if (!seen.has(key)) seen.set(key, bd.show(ws, at));
    const bead = await seen.get(key);
    // A bead the tracker has no row for is not a failure — the id came off a pull
    // request and beads get deleted. It simply states nothing, and has no parent to
    // walk to, so the chain ends here.
    if (!bead) return null;

    const value = opinionOf(bead);
    if (value !== null) return { value, from: bead.id || at };
    at = String(bead.parent || '');
  }
  return null;
}

/**
 * Does this merge ship itself?
 *
 * `row` is a board row from lib/prboard.js, whose `beads` is the work it delivered —
 * resolved against the tracker by lib/beadref.js, so these are beads that exist rather
 * than ids scraped out of prose.
 *
 * Returns `{ auto, known, why }`. `why` is a sentence for the log, because the one
 * question anybody will ask about an unattended deploy is *what decided that*, and the
 * answer has to survive to a log line rather than living in this function.
 *
 * **A `false` anywhere beats a `true` anywhere.** A pull request delivering two beads is
 * unusual and it happens; if one of them is held back by its epic, this does not fire.
 * The alternative — first bead wins — makes the answer depend on the order lib/beadref.js
 * happened to resolve them in, which is no answer at all.
 */
export async function resolveAutoShip(bd, cfg, ws, row, { seen = new Map() } = {}) {
  const space = autoShipAllowed(cfg, ws.name);
  const beads = (row?.beads || []).filter((b) => b?.id);

  const opinions = [];
  for (const bead of beads) {
    let found;
    try {
      found = await opinionAbove(bd, ws, bead.id, { seen });
    } catch (err) {
      return {
        auto: false,
        known: false,
        why: `could not read ${bead.id} or its parents — ${String(err.message).split('\n')[0]}`,
      };
    }
    if (found) opinions.push(found);
  }

  const held = opinions.find((o) => o.value === false);
  if (held) return { auto: false, known: true, why: `${held.from} holds its work back` };
  const sent = opinions.find((o) => o.value === true);
  if (sent) return { auto: true, known: true, why: `${sent.from} ships its own work` };

  const where = beads.length ? 'no bead above it says otherwise' : 'it names no bead';
  return {
    auto: space,
    known: true,
    why: `${ws.name} ${space ? 'auto-ships' : 'waits for a tap'} and ${where}`,
  };
}
