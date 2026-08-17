/**
 * The teeth: a bead with nothing decided above it is not workable.
 *
 * bc-rfnr.7, and the half of the epic that is a *rule* rather than a screen. bc-rfnr.2
 * draws an inbox containing only what descends from a root you own; on its own that is a
 * filter over a list, and the advocate goes on opening unattended sessions on everything
 * else at the next tick — work happening all night with nothing on the phone accounting
 * for it, which is a worse state than the flat list it replaced.
 *
 * So the same question the inbox asks of a row, the launcher asks of a bead, and the
 * answer is `underAnyOf` (lib/ancestry.js) against a root set built here.
 *
 * **A root is a P0 or an epic at any priority** — `isRoot` in lib/ownership.js, and that
 * file carries the argument for why the two together rather than either alone. This file
 * was `lib/underp0.js` until bc-htoy and every root in it was a P0; the rename is the concept
 * catching up with the rule, because a symbol that says P0 while meaning something wider
 * is the drift that makes the next reader wrong.
 *
 * **Two layers, and they are lib/endorse.js's two, on purpose.** That file's argument is
 * the one being reused wholesale and it is worth not re-deriving:
 *
 * 1. **A filter**, in the advocate's survey — the bead is out of the queue and out of the
 *    count that says how much work is waiting. This is what keeps layer 2 from being
 *    reached, which is exactly why it is not the guarantee.
 * 2. **A refusal**, at the door — `openWorkSession` and `openPlanSession` ask the tracker
 *    themselves, so a bead that reached the launcher by a retry, a tap on a stale row, or
 *    a caller written next month still cannot be worked.
 *
 * **Every cap is loud (lib/advocate.js's rule, and this file inherits it).** A bead
 * withheld with nothing on screen reads exactly like an advocate that decided there was
 * nothing to do — which is the failure this epic exists to remove, arriving through the
 * mechanism meant to fix it. So a skip is three things: a line in the log, an event on
 * the bus, and a pill on the advocate's card. And because the fix is a *tracker* edit
 * rather than a wait, the bead sheet offers it: pick an epic to adopt it (public/graph.js).
 *
 * ## Three decisions, none of them inherited
 *
 * **A root is any *open* one, not only one you own.** The board is `ownedByMe` because a
 * screen is answering "what am I answerable for"; this gate is answering "did anybody
 * decide this work should happen", and a colleague's epic on a shared graph is a decision.
 * Scoping the gate to your own roots would mean a six-person squad's advocate refused five
 * sixths of the tracker — the federation bc-y3qk is heading for, broken on arrival.
 *
 * **Open, though — a closed root is not one.** This is the case bc-rfnr.7's own comment
 * says to decide rather than inherit: an ancestor chain that dead-ends in something
 * closed. It resolves the way the board already resolves it, because the two must not
 * disagree. lib/server.js's `rootBoard` leaves closed roots off the screen and stops
 * pulling their descendants in with them; if the gate counted them, a child left open
 * under a finished epic would be dispatched all night while being invisible on the phone
 * — the one combination this epic is built to make impossible. The cost is honest and is
 * the one the bead names: the first time an epic closes over an open child, that child
 * stalls, wearing a pill that says why and offering the fix. A stall you can see beats
 * work you cannot.
 *
 * **An unreadable graph withholds nothing.** Deliberately the opposite of
 * `assertEndorsed`, which refuses when it cannot check — and the difference is what the
 * evidence *is*. There, a failed `bd show` is one bead nobody can vouch for. Here, a
 * failed `bd export` is the whole workspace, so failing closed would stop every session
 * on the Mac on a Dolt write lock, and it would do it silently in the direction that
 * looks exactly like a quiet night. lib/bd.js's `graph` already records this as the
 * decision ("the dispatch gate withholds nothing"); this is that sentence implemented.
 * An empty index and a workspace that genuinely has no beads are indistinguishable from
 * in here, and both mean the same thing anyway: nothing to be sure about, so hold
 * nothing back.
 */
import { underAnyOf } from './ancestry.js';
import { isRoot } from './ownership.js';

/** What the pill says, and the phrase the fix is written against. One spelling. */
export const NO_ROOT_ABOVE = 'nothing decided above this';

/**
 * Every open root in a workspace — what this gate measures against.
 *
 * Takes the `beads` half of `Bd.graph`'s index (or any iterable of rows), because the
 * caller that has a tracker to ask is not the caller that knows what a root is — the
 * split the whole of lib/ancestry.js is written to.
 */
export function rootsOf(beads) {
  const roots = new Set();
  for (const b of beads?.values?.() || beads || []) {
    if (!b || !isRoot(b)) continue;
    if (String(b.status || '').trim().toLowerCase() === 'closed') continue;
    roots.add(String(b.id));
  }
  return roots;
}

/**
 * Is there a root above this bead? The whole rule, over an index already in hand.
 *
 * **True when there are no roots at all**, which is the fail-open above wearing its other
 * hat: a workspace whose graph could not be read has no roots, and so does one nobody has
 * filed an epic or a P0 in yet. Neither is a reason to stop work, and `underAnyOf` answers
 * `false` for an empty root set — so the check has to be here rather than left to it.
 *
 * **A root is above itself.** `underAnyOf` puts a root in its own set, which is what makes
 * one predicate serve the board and the gate; here it is also bc-rfnr.4 working: a crash
 * the app filed on itself is a P0 by construction (lib/errors.js), so it passes this
 * without a special case and stays a leaf you can work directly. An epic passes it the
 * same way, which is what makes a P2 epic workable the moment it is filed rather than
 * only once somebody hangs it under something more urgent.
 */
export function hasRootAbove(index, id) {
  const beads = index?.beads;
  const parents = index?.parents;
  const roots = rootsOf(beads);
  if (!roots.size) return true;
  return underAnyOf(parents, id, roots);
}

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and a named boolean — `noRoot` — matching lib/endorse.js, lib/superseded.js
 * and lib/stillopen.js field for field, so a caller can tell this refusal from a launch
 * that failed. The advocate has no business retrying this one: nothing about it changes
 * until somebody reparents the bead.
 *
 * The sentence names the fix rather than only the fault, because unlike the other three
 * refusals this one is not a wait. Nothing clears it on its own. It names an epic first
 * and the priority second, because since bc-htoy filing an epic is the cheap fix and
 * raising a P0 is the one that also claims the work is urgent.
 */
export const refusal = (id) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — ${NO_ROOT_ABOVE}, and a bead nothing has decided is not work. ` +
        'Adopt it under an epic at any priority (or raise a P0) and it becomes workable with no other change.'
    ),
    { status: 409, noRoot: true }
  );

/**
 * The gate at the door, given the row `assertEndorsed` has already read.
 *
 * Costs one `Bd.graph` — an export, ~1.3s, cached for a minute per workspace and shared
 * with the inbox's own sweep, so in practice a launch pays for it about as often as the
 * phone does. `wait: true` here where the request path uses `wait: false`: a door that is
 * about to spend twenty seconds opening an iTerm window can afford to be right, and the
 * request path cannot (see the measurement on `Bd.graph`).
 *
 * **A caller with no `bd` is not refused**, which is the one place this reads as weaker
 * than `assertEndorsed` and is the same fail-open as everything else here: no tracker to
 * ask is no evidence, and no evidence must not empty the queue. The endorsement gate can
 * afford the other answer because the bead itself carries its own marker.
 */
export async function assertUnderRoot(bd, workspace, issue) {
  const id = typeof issue === 'string' ? issue : issue?.id || '';
  if (typeof bd?.graph !== 'function') return issue;
  const index = await bd.graph(workspace);
  if (!hasRootAbove(index, id)) throw refusal(id);
  return issue;
}
