/**
 * Keeping a tracker that two Macs share actually shared.
 *
 * Everything else in beadcause treats "the tracker" as one thing. It is one thing on
 * one machine: `~/beads/<name>/.beads` is an embedded Dolt database on this laptop's
 * disk, and a bead created here is visible here. Dolt can be pushed to a remote and
 * pulled from one — `bd dolt push` / `bd dolt pull` — and until this file **nothing in
 * beadcause had ever called either**. Five comments in lib/bd.js and lib/config.js talk
 * about embedded versus `bd dolt start` mode; not one line syncs anything. Syncing was
 * a thing a person types, which means on the days nobody typed it two engineers running
 * beadcause had two private issue graphs that never met.
 *
 * That is bead 0 of the federation epic (bc-hlu2), and it is bead 0 because everything
 * downstream of it — a second engineer installing against the team's tracker, a question
 * addressed to one person rather than broadcast, two advocates not opening a session on
 * the same bead — is arithmetic over a graph both machines can see. None of it means
 * anything while the graph is private.
 *
 * ## Which workspaces sync: the ones that have a remote, and nothing else
 *
 * Deliberately **not** a list in the config, and this is the one design decision here
 * worth arguing. The obvious shape is `sync.workspaces: ["climative"]` — say which are
 * shared, sync those. The trouble with it is that it is a second place to be right: a
 * workspace can have a Dolt remote and be absent from the list (so it silently does not
 * sync, which is the failure this file exists to prevent), or be in the list with no
 * remote (so every tick reports a failure about a workspace that is working exactly as
 * intended).
 *
 * `bd dolt remote list --json` already answers the question, from the workspace itself,
 * and it cannot disagree with itself. So: **a workspace with a remote is a workspace
 * that syncs, and a workspace without one is silent.** A solo install — every workspace
 * on this Mac today — configures nothing, is told nothing, and pays one cheap `bd` call
 * per workspace per interval to establish that there is nothing to do. The day somebody
 * runs `bd dolt remote add origin …`, sync starts on the next tick with nothing else
 * typed. That is the acceptance criterion for bc-hlu2 read literally: visible on the
 * other machine *without anybody typing a sync command*.
 *
 * Note what this deliberately does not do: it never *adds* a remote. Where a graph is
 * published is a decision with consequences no daemon should make on somebody's behalf
 * — the beadcause repo itself is public, and a remote pointed there would put every
 * bead, comment and answer on the open internet — so beadcause syncs a remote that
 * exists and never invents one. See the README section for the fuller argument.
 *
 * ## Pull, then push, and never the other way round
 *
 * A push against a remote that has moved is refused, so pushing first turns an ordinary
 * two-machine afternoon into an error every single tick. Pulling first is what merges
 * the other machine's beads into this one's history so there is something pushable —
 * and it is also the half that matters most, because a machine that pulls and never
 * pushes is merely behind, while a machine that pushes and never pulls is the one
 * writing over other people's work.
 *
 * ## Three ways it goes wrong, and only two of them are the same
 *
 * - **It failed.** Network down, `gh`/ssh not authorised, the tracker locked by one of
 *   the twenty agent sessions this laptop runs. Transient by nature, retried on the
 *   next interval, and the honest thing to say is "these two machines are drifting
 *   apart and here is what bd said".
 * - **It conflicted.** Two machines wrote the same bead and Dolt cannot merge them. This
 *   never resolves itself and it never will: the next tick hits the same conflict, and
 *   every tick after that. It is called out separately for exactly that reason — the
 *   remedy is a person at a keyboard, and a screen that files it under the same word as
 *   "the wifi dropped" is a screen that teaches you to ignore it.
 * - **It has no remote.** Not a failure at all, and reported as nothing.
 *
 * ## Quiet when it works, loud once when it does not
 *
 * A sync that worked says nothing. A tick that reports "synced 4 workspaces" every two
 * minutes is 720 lines a day that nobody reads, and the 721st — the one that says it
 * failed — is the one that scrolls past. So the *transitions* are what talk: the first
 * failure emits an event and pushes to the phone, and so does the recovery. Between
 * those two the record stands, on the inbox banner and in `trouble()`, for as long as
 * it is true. This is `pushCertificate`'s argument in lib/notify.js, applied one layer
 * down.
 *
 * Deliberately not persisted, for the same reason lib/sweep.js is not: a restart has no
 * memory of yesterday's divergence and should find out by syncing, and a failure that
 * did not survive the restart is not a failure any more.
 */

/** The one line of an error worth putting on a phone. Same bar as lib/sweep.js. */
const oneLine = (err) => {
  const text = err && err.message ? String(err.message) : String(err ?? 'unknown error');
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0] || '';
  // `bd … failed in <ws>: <what bd said>` — lib/bd.js's prefix, which repeats a
  // workspace name the row already carries and is half a phone's line width gone
  // before the reason starts. Trimmed here exactly as lib/sweep.js trims it.
  const colon = first.indexOf(': ');
  const trimmed = colon > 0 && /(failed|timed out) in /.test(first.slice(0, colon)) ? first.slice(colon + 2) : first;
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed || 'unknown error';
};

/**
 * Did Dolt refuse this because the two histories disagree?
 *
 * Text-matched, because that is the only thing `bd dolt pull` gives us — it exits
 * non-zero for a conflict and for a dead network alike, so the exit code cannot tell
 * them apart. Matched loosely on purpose: a false positive here calls a network blip a
 * conflict, which over-reports a problem that is already being reported; a false
 * negative files a divergence that will never clear under the word "retrying", which
 * is the one outcome this distinction exists to prevent.
 */
const CONFLICT_RE = /\bconflict|cannot be merged|merge is not fast.?forward|unresolved/i;

export const isConflict = (text) => CONFLICT_RE.test(String(text || ''));

/**
 * How often a sync runs, in ms, with a floor.
 *
 * **The interval is not a performance knob.** It is the width of the window in which
 * two machines can act on stale information — the same window bc-bllw's duplicate
 * advocate sessions live in — so the argument for the default is about collisions and
 * not about load.
 *
 * Two minutes. The poll is thirty seconds and the release sweep is five minutes, and
 * this sits between them for a reason: it is the only sweep here that touches both the
 * network *and* Dolt's single writer, so it is genuinely more expensive than the
 * thirty-second reads — while a five-minute window is long enough for two advocates on
 * two Macs to both pick up the same ready bead and both open a session on it, which is
 * a wasted hour rather than a slow screen.
 *
 * The floor is thirty seconds rather than the five `pollSeconds` gets, because there is
 * no such thing as a usefully faster sync: a `git push` per workspace every few seconds
 * would spend more of the day holding the Dolt write lock than the agent sessions do,
 * and the collision window it closes is already smaller than the time it takes a person
 * to read a bead.
 */
export const SYNC_FLOOR_SECONDS = 30;

export const syncEveryMs = (cfg) => Math.max(SYNC_FLOOR_SECONDS, Number(cfg?.sync?.seconds) || 120) * 1000;

/** Is syncing on at all? Off is a real answer and it is the one a solo install wants. */
export const syncEnabled = (cfg) => cfg?.sync?.enabled !== false;

/**
 * Sync one workspace, once. Never throws.
 *
 * The outcome is a word rather than a boolean because there are four of them and three
 * of the four are not failures:
 *
 *   `no-remote` — nothing to do, say nothing
 *   `ok`        — pulled and pushed
 *   `failed`    — it did not work, and it may next time
 *   `conflict`  — it did not work, and it will not next time
 *
 * `pushed: false` on an `ok` is the ordinary read-only case: a pull that succeeded and
 * a push that had nothing to send is still a workspace in agreement with the remote.
 */
export async function syncOnce(bd, workspace) {
  // The directory a *person* would type this in, carried on the outcome so nothing
  // downstream has to guess it. `~/beads/<name>` was the obvious guess and it is already
  // wrong: a workspace can live anywhere — Climative's moved inside the `architecture`
  // checkout, because that is the repo the team clones — and a notification whose
  // suggested command is a path that does not exist is worse than one with no command
  // in it, since the first thing it teaches you is that the message is not to be trusted.
  const at = workspace?.dir ? workspace.dir.replace(/\/\.beads\/?$/, '') : null;
  let remote = null;
  try {
    remote = await bd.doltRemote(workspace);
  } catch (err) {
    return { workspace: workspace.name, dir: at, state: 'failed', at: nowIso(), error: oneLine(err), remote: null, phase: 'remote' };
  }
  if (!remote) return { workspace: workspace.name, dir: at, state: 'no-remote', at: nowIso(), remote: null };

  // Pull first — see the header. A push against a moved remote is refused, so the other
  // order reports a failure every tick on a tracker that is working perfectly.
  for (const phase of ['pull', 'push']) {
    try {
      await (phase === 'pull' ? bd.doltPull(workspace) : bd.doltPush(workspace));
    } catch (err) {
      const error = oneLine(err);
      return {
        workspace: workspace.name,
        dir: at,
        state: isConflict(err?.message || error) ? 'conflict' : 'failed',
        at: nowIso(),
        error,
        remote,
        phase,
      };
    }
  }
  return { workspace: workspace.name, dir: at, state: 'ok', at: nowIso(), remote };
}

const nowIso = () => new Date().toISOString();

/**
 * What each workspace's last sync did, and what changed since the one before it.
 *
 * The record is the whole point: a screen can only say "these machines are diverging"
 * if something remembers that the last three attempts failed, and a notification can
 * only be sent *once* if something remembers that it already was.
 *
 * Shaped to be driven by a test without a daemon or a real `bd`: `sweep` takes the
 * workspaces and does the calls, `record` takes an outcome that already happened. The
 * failure path is the one that matters and the one that is hardest to produce for real
 * — you cannot easily make two Macs disagree from inside a test — so it is the half
 * that is deliberately reachable with a fake.
 */
export function createSyncer({ bd = null } = {}) {
  /** workspace name → the last outcome we recorded for it. */
  const last = new Map();
  /** Guards against two syncs of the same workspace overlapping — see `sweep`. */
  const inflight = new Set();

  /**
   * Fold one outcome in, and say what changed.
   *
   * `transition` is `null` on the ordinary tick — failed again, or worked again having
   * worked before — and that null is what keeps the monitor's event log and the phone's
   * notification tray usable. Only `broke` and `recovered` are worth a noise, and
   * `changed` says whether the *reason* moved (a network failure becoming a conflict),
   * because that is a different sentence on the same screen.
   */
  function record(out) {
    const before = last.get(out.workspace) || null;
    last.set(out.workspace, out);
    const wasBad = Boolean(before && (before.state === 'failed' || before.state === 'conflict'));
    const isBad = out.state === 'failed' || out.state === 'conflict';
    const transition = isBad && !wasBad ? 'broke' : !isBad && wasBad ? 'recovered' : null;
    const changed = Boolean(transition) || (isBad && wasBad && before.state !== out.state);
    return { ...out, transition, changed, before: before ? before.state : null };
  }

  return {
    record,

    /** The last outcome per workspace, for anything that wants the whole picture. */
    all: () => [...last.values()].sort((a, b) => a.workspace.localeCompare(b.workspace)),

    /** One workspace's last outcome, or null if it has never been swept. */
    get: (name) => last.get(name) || null,

    /**
     * Every workspace whose tracker is not in agreement with its remote, in the shape
     * lib/sweep.js's `trouble()` uses — so a payload carrying both puts them side by
     * side without a second shape to learn.
     *
     * `channel: 'sync'` rather than one of the three read channels, and in its own
     * field on the payload rather than merged into `trouble`. That is deliberate:
     * `mergeTrouble` keeps one row per workspace and the most recent wins, so a locked
     * Dolt read arriving a second after a divergence would *hide* the divergence — and
     * the two say completely different things. "This repo could not be read" is a
     * screen that is out of date. "This repo is not in sync" is a screen that is out of
     * date **on the other machine too, and neither of you can tell**.
     */
    trouble() {
      return [...last.values()]
        .filter((o) => o.state === 'failed' || o.state === 'conflict')
        .map((o) => ({
          workspace: o.workspace,
          dir: o.dir || null,
          channel: 'sync',
          state: o.state,
          conflict: o.state === 'conflict',
          error: o.error || 'the sync failed',
          phase: o.phase || null,
          remote: o.remote || null,
          at: o.at,
        }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },

    /**
     * Sync every workspace, in parallel, and hand back what changed.
     *
     * Parallel because they are separate databases and separate remotes: nothing is
     * shared between two workspaces' syncs, and doing them in turn would make the
     * cycle's cost the *sum* of the slowest case rather than the slowest single one.
     * A `bd` that goes to the network gets two minutes before it is killed
     * (`BD_TIMEOUT`), and four workspaces in turn is eight minutes of a poll cycle.
     *
     * `inflight` is the guard that makes that safe. `setInterval` does not wait for an
     * async callback to finish, so a sync that outlives its interval would otherwise
     * have a second one started on top of it — two `bd dolt push` against one embedded
     * Dolt, fighting over the single write lock, each making the other slower. A
     * workspace already syncing is skipped rather than queued: the next tick is two
     * minutes away and there is nothing to catch up on.
     */
    async sweep(workspaces) {
      const all = workspaces || [];
      // Both lists are taken *before* anything is awaited, because `inflight` is what
      // this tick is about to change: reading it afterwards would report every
      // workspace this tick synced as one it skipped.
      const due = all.filter((w) => !inflight.has(w.name));
      const skipped = all.filter((w) => inflight.has(w.name)).map((w) => w.name);
      for (const w of due) inflight.add(w.name);
      const outs = await Promise.all(
        due.map(async (w) => {
          try {
            return record(await syncOnce(bd, w));
          } finally {
            inflight.delete(w.name);
          }
        })
      );
      return {
        results: outs,
        // What is worth a line, an event and a push: only the transitions.
        changed: outs.filter((o) => o.changed),
        skipped,
      };
    },
  };
}

/** Where a workspace's beads go, in as few characters as still identify the repo. */
export const remoteLabel = (remote) => (remote ? remote.url || remote.name || 'its remote' : 'its remote');

/** How a sync outcome reads in one line, on a log or in a notification. */
export function describeSync(out) {
  if (!out) return 'never synced';
  switch (out.state) {
    case 'ok':
      return `in sync with ${remoteLabel(out.remote)}`;
    case 'no-remote':
      return 'no Dolt remote — nothing to sync';
    case 'conflict':
      return `CONFLICT on ${out.phase || 'sync'} — ${out.error || 'Dolt could not merge the two histories'}`;
    case 'failed':
      return `${out.phase || 'sync'} failed — ${out.error || 'unknown error'}`;
    default:
      return String(out.state);
  }
}
