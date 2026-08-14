/**
 * The fourth reason a bead may not be worked: it is a ship bead, and shipping is a tap.
 *
 * lib/release.js files one bead per merged-but-undeployed pull request, and its acceptance
 * criterion is not something an agent can satisfy: *the merge commit for #164 is in what
 * beadcause is running*. Only a deploy makes that true, and a deploy is deliberately not an
 * agent's to run. The bead's own rendered text says so — "nothing will open a session on it
 * — shipping is Adam's tap, not an agent's."
 *
 * **That promise used to rest on `unendorsed`, which is a label a tap is designed to take
 * off.** release.js filed with `[SHIP_LABEL, UNENDORSED]` and left it there: the marker kept
 * ship beads out of `Bd.ready`, so nothing opened a session on one. But lib/endorsequeue.js
 * lists the endorsement screen as `bd.listLabel(ws, UNENDORSED)` with no filter, so every
 * ship bead appeared on it as something to judge, and "Endorse all" — one tap, which is the
 * whole point of that button — took the lot. On 2026-08-11 it did: PRs #147–#174 lost the
 * marker in one go, and on 2026-08-13 twenty-five of the seventy-five rows in the advocate's
 * ready queue were ship beads. Three unattended worker windows were opened on three of them
 * (bc-dc3u, bc-lnph, bc-izs0), each costing a session slot and an hour of tokens to
 * rediscover the same nothing, and each one filed or annotated the bead you are reading the
 * fix for.
 *
 * Re-adding the marker by hand does not hold, and that was measured rather than guessed. The
 * queue sorts `newestFirst` and slices to `QUEUE_MAX`; ship beads are the highest-frequency
 * thing filed here, one per merged pull request, so they sit permanently at the front of
 * that slice. Endorse all does not *happen* to catch them — the ordering guarantees it, and
 * re-labelling cannot move them out because it does not change `created_at`. Twenty-five
 * beads were repaired on 08-13 and twelve were back the next morning.
 *
 * So the guarantee has to key on `ship` itself, which nothing on a phone can take off, and
 * it is the same two layers everything else here is built from — lib/endorse.js's pair, for
 * lib/endorse.js's reason:
 *
 * 1. **A filter**, in `QUEUE_EXCLUDED` and forced on by `Bd.ready`, and again in
 *    `endorsementQueue` — a ship bead is in no queue that says how much work is waiting,
 *    and on no screen that asks whether an hour of agent should be spent on it. This is
 *    what keeps layer 2 from ever being reached, which is why it is not the guarantee.
 * 2. **A refusal**, in `openWorkSession` and its two siblings — the launcher reads the row
 *    the tracker just returned, and a ship bead handed straight to it still cannot be
 *    worked, **whatever its endorsement state**. That is the point: this refusal has to
 *    survive the tap that the old one did not.
 *
 * **Its own module, and that is not tidiness.** `SHIP_LABEL` cannot simply live in
 * lib/release.js and be read from lib/endorse.js, because release.js already imports
 * endorse.js and that is a cycle. It cannot live in endorse.js either: endorsement is a
 * judgement nobody has made yet, and a ship bead is not awaiting one. One string, one
 * place, imported by both — release.js re-exports it so the name stays where its callers
 * already look for it.
 *
 * **Shipping is untouched by all of this.** `openShipBeads` finds ship beads with
 * `bd.listLabel(ws, SHIP_LABEL)`, which is a query on the label and not on the ready queue,
 * and the pull request board draws from that. Filtering ship beads out of the *agent's*
 * queues cannot take one off the board, which is the only screen that closes them.
 */

/** The label a ship bead carries. One string, one place. */
export const SHIP_LABEL = 'ship';

/** Is this bead one? Takes a `bd --json` row, or anything with `labels`. */
export const isShipBead = (issue) =>
  (issue?.labels || []).some((label) => String(label).trim() === SHIP_LABEL);

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and a named boolean, matching lib/endorse.js, lib/superseded.js and
 * lib/stillopen.js field for field: a caller can tell this refusal from a launch that
 * failed, and the advocate has no business retrying it — where iTerm refusing is worth a
 * second go.
 */
export const refusal = (id) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — it is a ship bead, and only a deploy closes one`
    ),
    { status: 409, ship: true }
  );

/**
 * The gate, given a row the caller has already read from the tracker.
 *
 * Takes no `bd` and makes no call, for `assertNotSuperseded`'s reason: it sits immediately
 * after `assertEndorsed`, which has just paid for the `bd show` and hands over what it
 * read. Trusting a *caller-supplied* row would be the hole lib/endorse.js closes; trusting
 * the row the tracker itself just returned is the same fact, already fetched.
 */
export function assertNotShipBead(issue) {
  if (isShipBead(issue)) throw refusal(issue?.id);
  return issue;
}
