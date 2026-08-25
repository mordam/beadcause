/**
 * The fourth reason a bead may not be worked: a window is already on it.
 *
 * On 2026-08-21 at 10:56Z three live `claude` processes were carrying the *identical*
 * worker brief for bc-7qo.11 — pids 84917, 85731 and 2693, in three worktrees, two of
 * them editing lib/server.js at the same minute. The daemon did not know: its log has
 * one `opened a session on bc-7qo.11` for the whole hour, `advocates.json` held one
 * worker row, and at 11:01:20Z it was still reporting `92 ready · at its limit of 2
 * session(s)`. bc-khoe.21 had three the same minute, and by the time anybody looked,
 * two of its three had independently written the same fix into two branches.
 *
 * None of the three was dispatched. Earlier that morning their windows had been torn
 * down mid-turn by the nightly maintenance sweep, and the *shells* survived — parent
 * shells three hours older than the processes inside them — and re-ran the command they
 * had been given. Nothing about that route passes through this daemon, so every counter
 * it keeps was bypassed: the session cap, the per-bead attempt count, and the claim.
 *
 * **A claim is no defence, and this is the part worth understanding before reaching for
 * one.** Every window on this Mac writes as the same `bd` actor, so each `--claim`
 * succeeds and each one is indistinguishable from the others; a lease renewed by three
 * windows reads exactly like a lease renewed by one. `bd` cannot tell them apart because
 * from where `bd` is standing they are not different.
 *
 * What *can* tell them apart is the process table. `sessionCommand` in lib/session.js
 * puts the whole brief on `claude`'s own command line — "You are working bead
 * **`<workspace>/<id>`**…" — so a workspace-qualified bead id is on a window's argv from
 * the instant the shell reaches it: before the session names itself, before it claims
 * anything, before it has run a single tool. That is the one fact about a live window
 * that needs no bookkeeping of ours and no forensics on process start times, and it is
 * what this module asks about. See `liveProcessesNaming` in lib/claude.js, which reads
 * it, and bc-xl7n.114, which is why it exists.
 *
 * ## Why a refusal at the door, when `withoutLiveSessions` already filters the queue
 *
 * lib/stillopen.js's argument, unchanged: *a guard that only holds when you can name the
 * route is a guard that holds until the day you cannot.* `withoutLiveSessions` in
 * lib/advocate.js drops a bead a live process names out of the tick's *queue* — which is
 * the right thing and covers the ordinary path — but it is a filter, it is switchable
 * (`holdLiveSessions`), and the queue is not the only way into `openWorkSession`. A
 * resumed conversation, a hand-fired dispatch, the console, and whatever is written next
 * all arrive at the same door and none of them has been past that filter. This is the
 * door.
 *
 * ## What it deliberately does not do
 *
 * - **It does not signal anything.** Two windows on one bead is a thing to stop happening
 *   again, not a reason to kill a session mid-turn; whichever window is already there is
 *   working, and the honest act is to not open a second one. Closing the one that is
 *   there is lib/reap.js's job and has four guards of its own.
 * - **It does not fail closed.** `liveProcessLines` is best-effort by design — no `ps`,
 *   no rows — so a process table that cannot be read leaves the launch alone rather than
 *   stopping the fleet on an unreadable answer. The queue filter is the belt.
 * - **It asks nothing when this process cannot open a window at all.** A suite is not
 *   going to put a second window on a bead, because `assertMayLaunch` will not let it put
 *   a first one there, and reading the whole process table to establish that would be a
 *   `ps` per gate in every suite that touches this door. Same reasoning as the refusal it
 *   sits beside, one layer earlier.
 */

import { liveProcessesNaming } from './claude.js';
import { mayLaunch } from './launchguard.js';

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and a named boolean, matching lib/stillopen.js, lib/endorse.js and
 * lib/superseded.js field for field: the advocate can tell this from a launch that
 * failed, and it has no business retrying it — where iTerm refusing is worth a second go.
 *
 * The pids ride into the message because that sentence is the whole of what a person
 * reading the log has to go on: `ps -p <pid> -o args -ww` prints the other window's whole
 * brief, which is what says which bead it is really on.
 */
export const refusal = (id, pids = []) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — ${pids.length} live window(s) already name it` +
        `${pids.length ? ` (pid ${pids.join(', ')})` : ''}`
    ),
    { status: 409, occupied: true, pids }
  );

/**
 * The gate. Throws if any live process's command line already names `<workspace>/<id>`.
 *
 * Async and `ps`-shaped rather than taking a census the caller already has, because the
 * callers here are the session doors and none of them has one: the advocate's snapshot is
 * a tick old and lives in another module, and a tick is long enough for the window this
 * is about. One `ps` per launch is a launch that happens seconds apart at the very most.
 *
 * `ps` is injectable in the shape lib/claude.js takes it, so a suite can drive both sides
 * of this without a process table of its own.
 */
export async function assertNoOtherWindow(workspace, id, { ps = null, env = process.env, argv = process.argv } = {}) {
  if (!workspace || !id) return [];
  // An injected `ps` is a caller saying "check this, against this table" — a suite proving
  // the door is wired, or the day something wants to ask on behalf of another process. It
  // is the deliberate act, so it wins over the skip, exactly as `BEADCAUSE_ALLOW_LAUNCH`
  // wins over both of `mayLaunch`'s layers.
  if (!ps && !mayLaunch(env, argv)) return [];
  const hits = await liveProcessesNaming(workspace, id, ps ? { ps } : {});
  if (hits.length) throw refusal(id, hits.map((h) => h.pid));
  return hits;
}
