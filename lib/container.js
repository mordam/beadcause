/**
 * The fifth reason a bead may not be worked: it is furniture, not work.
 *
 * bc-xl7n.14. Some beads are not jobs — they are the standing roots everything else is
 * filed under. bc-w156 says of itself "a permanent container, not a piece of work" and
 * its acceptance says the root must exist and not be closed; bc-xl7n is "the unsorted
 * backlog — every bead nothing has yet decided a home for". Both sentences are prose,
 * and until this file existed nothing in the daemon could read either one.
 *
 * **What that cost, measured on 2026-08-13.** bc-w156 was an open P0 epic with no
 * children, so it sat in `bd ready` like anything else. `batchesFor` (lib/advocate.js)
 * skips an epic whose ready children are below `minBatchBeads`, so a *childless* epic is
 * never a batch head and never a planner candidate — it falls through the hierarchy
 * filter and is dispatched as an ordinary ready bead. That is a worker window, and a
 * worker window's one sanctioned ending is `bin/deliver.js -b <bead>`, which runs
 * `bd close <bead>`. So an advocate tick that found a standing root ready opened a
 * session whose *successful completion deletes the root from the board*. Three windows
 * were opened on that state in two days; all three survived only by reading the prose
 * and handing back, which is precisely the protection lib/superseded.js exists to
 * replace — "the gap was that it had no machine-readable form".
 *
 * bc-vriu and bc-xl7n were safe by an accident and not a property: they happened to have
 * ready children. The day the last child of either closes, they are bc-w156.
 *
 * **A label, not a status, not a type, and not an absence of children.** The same
 * argument lib/endorse.js makes: bd's statuses already mean things about the dependency
 * graph or the clock and none of them says "this is a shelf", and a label is what
 * `bd ready`, `bd list` and `bd human` can all filter on today. `issue_type` was the
 * other candidate and is worse — an epic is a container *sometimes*, and epic-ness is
 * load-bearing for the dependency rules lib/park.js is built around (`bd` refuses an
 * edge between an epic and a task), so overloading it would make "may this be worked"
 * and "may this be parked behind that" one question with two answers.
 *
 * **Two layers, and they are lib/endorse.js's two, for lib/endorse.js's reasons:**
 *
 * 1. **A filter**, in `Bd.ready` — forced on there rather than left to the caller, so
 *    nothing can ask for a queue containing a container. The bead leaves every queue and
 *    every count of how much work is waiting. This is what keeps layer 2 from being
 *    reached, which is exactly why it is not the guarantee.
 * 2. **A refusal**, at the doors — `openWorkSession` and `openPlanSession` read the row
 *    `assertEndorsed` has already fetched, so a container that reached the launcher by a
 *    retry, by a tap on a stale row, or through a caller written next month still cannot
 *    be worked. This *is* the guarantee.
 *
 * ## Three decisions, none of them inherited
 *
 * **The P0 advocate door is deliberately left open, and it is the only one of the four
 * gates in front of `openWorkSession` that is not applied at all three doors.** A
 * standing root is exactly the bead an EpicAdvocate is for: it is re-entrant, it belongs
 * to its epic for as long as the epic is open (`assignedAdvocates`, lib/epicadvocate.js),
 * it files children *under* the root, and — the whole point — **it never closes it**.
 * Refusing containers there would take the one agent that is supposed to look after a
 * standing root and point it at everything except standing roots, which is the failure
 * this file exists to fix, arriving through the fix. If you are adding
 * `assertNotContainer` to a third door, that door is the one to leave alone.
 *
 * **A container still draws on the P0 board, and no code was needed for that.**
 * `p0Board` (lib/server.js) is built from `bd.graph` and not from `bd.ready`, so a bead
 * this file removes from every queue is untouched on the screen. That is the right way
 * round and it is the acceptance criterion this bead was filed with: the board's
 * furniture has to be visible *as* furniture. A container that vanished from the phone
 * the moment it became unworkable would be a root nobody could file under, and filing
 * under it is what it is for.
 *
 * **Nothing here is loud, which is a departure from lib/underp0.js.** That file's rule is
 * that every cap is announced — a line, a bus event, a pill — because a bead withheld
 * with nothing on screen reads as an advocate that decided there was nothing to do. This
 * one is the opposite case and the same reasoning: a container is not *withheld* work, it
 * is not work, and a queue that announced "holding bc-xl7n" every thirty seconds for the
 * life of the daemon would be teaching everyone to scroll past exactly the kind of line
 * lib/underp0.js needs read. The refusal at the door is loud, because that one is a
 * caller being told no.
 *
 * ## What this is not strong enough to be
 *
 * A container is not protected from `bd close`, and could not be: bd is a separate tool
 * and this daemon has no hook in it. What it is protected from is the *only ending a
 * dispatched session has* — nothing opens a window on it, so nothing runs `bin/deliver.js`
 * against it. The belt on top of that is already there and is not this file's: deliver
 * refuses to close an **epic** on a merge (`epicStaysOpen`, bin/deliver.js), and every
 * standing root is an epic. Adding a container check beside it would be a second spelling
 * of a rule that already holds.
 */

/** The marker. One string, one place, because three spellings is the same as no hold. */
export const CONTAINER = 'container';

/** Does this bead carry the marker? Takes a `bd --json` row, or anything with `labels`. */
export const isContainer = (issue) =>
  (issue?.labels || []).some((label) => String(label).trim() === CONTAINER);

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and a named boolean — `container` — matching lib/endorse.js,
 * lib/superseded.js, lib/stillopen.js, lib/shipbead.js and lib/underp0.js field for
 * field, so a caller can tell this refusal from a launch that failed. The advocate has
 * no business retrying this one: nothing about a container changes, ever, which is what
 * being one means.
 *
 * The sentence says what the bead is *for* rather than only what it is not, because the
 * reader of this message is usually somebody who tapped "work on this" on a P0 card and
 * needs to know where the work actually goes.
 */
export const refusal = (id) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — it is a ${CONTAINER}: a standing root that beads are ` +
        'filed under, not a piece of work. Work one of its children, or file a new one under it.'
    ),
    { status: 409, container: true }
  );

/**
 * The gate, given a row the caller has already read from the tracker.
 *
 * Takes no `bd` and makes no call, for `assertNotShipBead`'s reason: it sits immediately
 * after `assertEndorsed`, which has just paid for the `bd show` and hands over what it
 * read. Trusting a *caller-supplied* row would be the hole lib/endorse.js closes;
 * trusting the row the tracker itself just returned is the same fact, already fetched.
 */
export function assertNotContainer(issue) {
  if (isContainer(issue)) throw refusal(issue?.id);
  return issue;
}
