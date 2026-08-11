/**
 * What each workspace's last sweep did — and what to draw for one that did not answer.
 *
 * The daemon reads every workspace under `~/beads/` on one clock, and a sweep is one
 * `bd` per repo. Those calls are independent and they fail independently: embedded
 * Dolt is single-writer, around twenty agent sessions share this laptop's workspaces,
 * and a read losing a lock race is an ordinary Tuesday rather than an outage.
 *
 * The handling before this was a `catch` that logged one line to the daemon's stdout
 * and returned `[]` for that repo. Every count downstream is arithmetic over the
 * survivors, so a repo whose `bd human list` threw did not appear as broken — it
 * appeared as **quiet**. The inbox drew "Nothing live", the picker drew a confident
 * zero beside it, and the only record of the failure was a console line on a machine
 * nobody is looking at. That is this app's one unforgivable failure mode wearing the
 * empty state as a costume: a question you were never told about.
 *
 * So a sweep is recorded rather than merely attempted, and two things follow from the
 * record:
 *
 * - **A failure is held, not swallowed.** `trouble()` is the list of repos that did
 *   not answer, each with the first line of its error, and it rides the inbox payload
 *   to the phone. Named, with the reason, above the list.
 * - **The last good answer stands in for a missing one.** A sweep that threw returns
 *   whatever that workspace last said instead of nothing. Stale rows are a smaller lie
 *   than an empty list: the bead really is open, it really is waiting, and the only
 *   thing that is out of date is how long it has been. A list that empties itself on a
 *   lock collision and refills a poll later is the incident this exists to prevent —
 *   and it is indistinguishable, from the outside, from having answered everything.
 *
 * Deliberately **not** persisted. A restart has no last-good answer for anybody and
 * should sweep for one, and a failure that did not survive the restart is not a
 * failure any more. The whole record is an in-memory fact about the running daemon.
 */

/** The one line of an error worth putting on a phone. */
const oneLine = (err) => {
  const text = err && err.message ? String(err.message) : String(err ?? 'unknown error');
  const first = text.split('\n')[0].trim();
  // `bd … failed in <ws>: <what bd said>` — the prefix repeats the workspace name the
  // row already carries, and on a phone that is half the width of the line gone before
  // the reason starts.
  const colon = first.indexOf(': ');
  const trimmed = colon > 0 && /failed in /.test(first.slice(0, colon)) ? first.slice(colon + 2) : first;
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed || 'unknown error';
};

/**
 * One channel's sweep record — questions, agent beads, or the foundation channel.
 *
 * One per channel rather than one shared, because the three ask `bd` different
 * questions and a repo can perfectly well answer one and fail the other. `channel` is
 * carried on every row so the phone can say which read it was.
 */
export function createSweep(channel) {
  /** workspace → the rows it last answered with. */
  const held = new Map();
  /** workspace → { workspace, channel, error, at, held }. */
  const failures = new Map();

  return {
    channel,

    /** It answered. Keep the rows, and forget it was ever in trouble. */
    ok(workspace, rows) {
      held.set(workspace, rows);
      failures.delete(workspace);
      return rows;
    },

    /**
     * It did not answer. Record why, and hand back what it last said.
     *
     * The `console.error` stays: the daemon's log is still where you go when you want
     * the stack rather than the sentence, and the monitor tails it.
     */
    failed(workspace, err) {
      const rows = held.get(workspace) || [];
      failures.set(workspace, {
        workspace,
        channel,
        error: oneLine(err),
        at: new Date().toISOString(),
        // How many rows are standing in for the ones we could not read. Zero means the
        // repo has never answered since the daemon started, which is the one case
        // where "nothing here" and "we do not know" really are the same screen — and
        // the reason the count must not be drawn as a confident zero either way.
        held: rows.length,
      });
      console.error(`[beadcause] ${workspace}: ${channel} sweep failed — ${oneLine(err)}`);
      return rows;
    },

    /**
     * Drop one bead from what is held, because we just wrote to it ourselves.
     *
     * The held rows are a stand-in for an answer nobody could get, and they are only
     * ever consulted while that is still true — so the one thing they must never do is
     * argue with a write this daemon has just made. Without this, answering a card
     * while its repo is unreadable closes the bead on disk and then puts the card
     * straight back on the next sweep, which is a worse screen than the one this whole
     * file exists to fix: the empty list was at least *about* the tracker.
     *
     * Keyed by id rather than by the `workspace/id` key, because the caller has the
     * workspace in hand and a key built two ways is a key that eventually disagrees.
     */
    forget(workspace, id) {
      const rows = held.get(workspace);
      if (!rows) return;
      held.set(
        workspace,
        rows.filter((r) => r?.id !== id)
      );
    },

    /** Every workspace that did not answer, oldest failure first. */
    trouble() {
      return [...failures.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
  };
}

/**
 * The three channels' failures as one list, one row per workspace.
 *
 * A repo whose Dolt is locked usually fails every read in the same sweep, and three
 * rows saying so is three times the same sentence on a screen that is four inches
 * wide. The most recent one wins; `channel` on it says which read produced the
 * message, and the counts stay per-channel where they are used.
 */
export function mergeTrouble(...sweeps) {
  const byWorkspace = new Map();
  for (const s of sweeps) {
    for (const row of s?.trouble?.() || []) {
      const seen = byWorkspace.get(row.workspace);
      if (!seen || String(row.at) >= String(seen.at)) byWorkspace.set(row.workspace, row);
    }
  }
  return [...byWorkspace.values()].sort((a, b) => a.workspace.localeCompare(b.workspace));
}

/** Just the names, for the callers that only need to know whether to trust a count. */
export const troubledNames = (trouble) => (trouble || []).map((t) => t.workspace);
