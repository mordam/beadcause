/**
 * The nightly maintenance window: stop dispatching, empty the Mac, collect the store.
 *
 * Every write to a beads workspace is a Dolt commit, and nothing ever collected them.
 * Measured on this repo's own workspace on 2026-08-17: **9469 commits and 825MB of
 * `noms` behind 1326 beads**, and the size is what a `bd` call pays for, because every
 * `bd` is a fresh process that opens the store from cold. The figures, on an idle
 * machine with a copy of the real workspace:
 *
 *     bd show <id>              1560–2710ms      after `bd gc`:  158–169ms
 *     bd list --all --limit 0   1862–2236ms      after `bd gc`:  326ms
 *     six of them at once      11972ms           after `bd gc`:  864ms
 *
 * `bd version`, which opens nothing, is 130ms. So a collected store puts `bd` within
 * 40ms of the floor and an uncollected one is ten times it — and the daemon spends
 * **381 seconds of `bd` in nine minutes** on an ordinary afternoon, which is what a
 * phone read queues behind. This is the cheapest large win available to this program
 * and it is one command.
 *
 * ## Why a window, when the collection itself is safe
 *
 * Worth being straight about, because it is the one thing a reader will assume the
 * wrong way round: **`bd gc` does not need the Mac to be empty.** It was measured with
 * six concurrent readers against the same store, and all six answered correctly while
 * it ran; bd takes its own gate lock, so a collection serialises against other `bd`
 * processes rather than racing them. It finished in 2.9 seconds. Nothing here is
 * protecting the database from the sessions.
 *
 * What the window is for is narrower and still worth having:
 *
 * - **A store collected under load is re-bloated by morning.** The commits come from
 *   writes, and the writes come from sessions. Collecting when the writers have stopped
 *   is what makes the small store last the night rather than an hour.
 * - **A 3-second collection is 3 seconds idle.** Under twenty sessions it is behind
 *   however much of that 381s/9min is queued in front of it, and every session's `bd`
 *   waits behind it in turn. That is not dangerous, but it is a stall in twenty windows
 *   at once, and workers have a `workerTimeoutMinutes` that a long enough one reaches.
 * - **The end of the night is the cheapest moment to stand a fleet down.** Windows that
 *   have finished but never exited are the pile lib/reap.js exists for; a nightly sweep
 *   that ends the ones still up is the same act on a schedule.
 *
 * So the collection is the point and the drain is hygiene. That ordering matters when
 * something goes wrong, and it is why the ceiling below collects rather than skipping:
 * **a night that fails to empty the Mac should still collect the store.**
 *
 * ## The shape
 *
 *     idle ──(the clock reaches maintenanceAt)──▶ draining
 *     draining ──(every window this daemon opened has ended)──▶ collecting
 *     draining ──(maintenanceDrainMinutes elapsed)──▶ closing ──▶ collecting
 *     collecting ──(bd gc returned)──▶ done ──▶ dispatching resumes
 *
 * `draining` asks; `closing` forces. Asking is `reclaim` in lib/advocate.js, which is
 * the button on the card and does exactly this already: it tells every worker to check
 * in, and it parks whatever is idle right now. Forcing is `finish(…, 'stood-down')`
 * plus the `force` arm of lib/reap.js — park the conversation first, then SIGTERM, then
 * SIGKILL. The order is the safety property and it is not this file's invention; see
 * `parkWorker`.
 *
 * ## Four rules it will not bend
 *
 * 1. **The decay phase is never run.** `bd gc` has three phases and the first one
 *    DELETES closed beads older than ninety days. That is the tracker's history — and,
 *    per this repo's own CLAUDE.md, the Dolt commit log is the recovery path when beads
 *    vanish. A nightly job that quietly deletes either is not maintenance. So the
 *    collection is `--skip-decay`, there is no config key to turn decay on, and if it is
 *    ever wanted it should be a deliberate act at a keyboard. `bd flatten` — which the
 *    gc output helpfully suggests, and which squashes all 9469 commits to one — is out
 *    for the same reason and more strongly: it is the recovery net itself.
 * 2. **The window always ends.** A session that will not take a signal, or a `bd gc`
 *    that hangs, must not leave a fleet that never dispatches again. `maintenanceMax
 *    Minutes` is the outer bound on the whole sequence, and past it dispatching resumes
 *    whatever state the sequence reached — loudly, because a night that could not finish
 *    is worth a sentence in the log.
 * 3. **The collection gets reserved time inside that bound.** `COLLECT_RESERVE` minutes
 *    before the ceiling, the sequence stops waiting for anything and collects. Derived
 *    rather than configured, because it is not a preference: it is the difference between
 *    a stuck window costing tonight's drain and a stuck window costing tonight's whole
 *    point.
 * 4. **Identity guards are never waived.** `force` skips the *busy* check and the grace
 *    period. It does not skip — and lib/reap.js will not let it skip — the check that the
 *    pid is still the session we launched. A signal is the one act here with no undo and
 *    pids get recycled; see `decide` there.
 *
 * ## Off by default
 *
 * `maintenance: false`, and deliberately. Everything else in this file is a read or a
 * `bd` call; this one closes windows somebody may be typing into, and a feature that
 * does that has to be switched on by the person whose windows they are. One line in
 * `~/.config/beadcause/config.json` turns it on:
 *
 *     "advocates": { "maintenance": true, "maintenanceAt": "03:00" }
 */

/** Minutes reserved at the end of the window for the collection itself. See rule 3. */
const COLLECT_RESERVE = 5;

export const MAINTENANCE_DEFAULTS = {
  // Off until asked for — see the header. On, this closes windows.
  maintenance: false,
  // Local wall-clock time, like `quietHours`, and for the same reason: "three in the
  // morning" means this Mac's small hours, not a UTC offset somebody has to convert.
  maintenanceAt: '03:00',
  // How long a window that is still working gets to finish on its own before it is
  // forced. Forty-five minutes rather than ten: a worker that has just been told to
  // wrap up has a debrief to write and a branch to deliver, and the whole value of
  // asking first is lost if the grace period is shorter than doing what was asked.
  maintenanceDrainMinutes: 45,
  // The outer bound on the whole sequence — rule 2. Two hours, which is
  // `workerTimeoutMinutes` and not a coincidence: a window still running at the end of
  // it is one the advocate would have given up on anyway.
  maintenanceMaxMinutes: 120,
  // Whether the drain is allowed to escalate to a signal. Off makes the window
  // ask-only: it still collects, at the reserve, over whatever is still running —
  // which is safe, and is the setting for anyone who wants the collection without
  // ever having a window closed under them.
  maintenanceForceClose: true,
  /**
   * Whether a workspace with a **Dolt remote** — a tracker shared with other people — is
   * collected too. Off, and this is the most conservative decision in the file.
   *
   * A personal store is this Mac's alone: a collection that went wrong costs one laptop's
   * history and `bd dolt` has no remote to disagree with. A shared one is a team's issue
   * graph, and on this Mac that is `architecture`, which about twenty work sessions and
   * every service checkout resolve to.
   *
   * `bd gc` phase 3 only reclaims *unreachable* chunks, so on today's bd this would be safe
   * there too. The reason to stay out is phase 2: **`compact` is not skippable.** There is
   * no `--skip-compact` — the flags are `--skip-decay` and `--skip-dolt` — and against bd
   * 1.2.1 it is advisory, reporting `9469 commits in history` and changing nothing. If a
   * later bd makes it actually squash, a nightly job would be silently rewriting the history
   * of a remote-backed database every night, which is the failure `bd migrate` refuses by
   * default and calls "silent and unrecoverable": two clones migrated independently fork,
   * and `bd dolt pull` can no longer merge. Nothing here would notice, and the people who
   * would notice are not at this keyboard.
   *
   * So the default is out, the skip is *reported* rather than silent, and turning it on is
   * somebody deciding they are the single designated migrator for that tracker — the same
   * thing `bd migrate --force` asks them to decide.
   */
  maintenanceCollectShared: false,
};

/** "03:00" → 180. Null for anything unparseable, so a typo switches the window off
 *  rather than firing it at midnight. Mirrors `minutesOfDay` in lib/spaces.js. */
export function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The most recent occurrence of `at`, on or before `now`. Null if `at` is unparseable.
 *
 * Looking *backwards* rather than forwards is what makes everything downstream simple.
 * A window at 23:30 with a two-hour bound runs past midnight, so "which night is this"
 * cannot be `now`'s date — it has to be the date of the start, and computing the start
 * first gives that for free. It also means a daemon that booted at 03:40 into a 03:00
 * window knows it is 40 minutes into tonight's, rather than having to reason about
 * whether it missed one.
 *
 * Built with the local-time constructor rather than by subtracting milliseconds, so a
 * window configured for 03:00 is still at 03:00 on the two mornings a year when the
 * day is not 24 hours long.
 */
export function windowStart(at, now = new Date()) {
  const mins = minutesOfDay(at);
  if (mins === null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (today <= now) return today;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, m, 0, 0);
}

/** Which night a start belongs to, as `YYYY-MM-DD` in local time. */
export function nightOf(start) {
  const p = (n) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
}

const clampMinutes = (v, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 60) : dflt;
};

/**
 * What the window should be doing right now.
 *
 * Pure: a clock, the options, and how many windows this daemon still has open. Every
 * effect is the caller's — which is what makes a state machine whose transitions are
 * "45 minutes later" and "the next night" testable without waiting for either.
 *
 * `prev` is the last verdict, and only two fields of it are read: `night`, so tonight's
 * collection happens once, and `phase`, so `collecting` is not re-entered while the
 * `bd gc` it started is still running. Both survive a daemon restart in the advocate's
 * state file, and both must: a `launchctl kickstart` at 03:20 that re-ran the drain,
 * or re-collected, would be a restart undoing the night.
 *
 * Returns `{ phase, act, why, night }`. `act` is what the caller should *do now* — and
 * it is deliberately not the same thing as `phase`, because most ticks are a phase
 * continuing with nothing new to do:
 *
 *     none     nothing to do
 *     ask      tell every window to wrap up (once, on entering the drain)
 *     force    park and signal whatever is still open
 *     collect  run the collection
 *     resume   the window is over; dispatching is allowed again
 */
export function decide(prev = {}, { o = {}, now = new Date(), live = 0 } = {}) {
  if (!o.maintenance) {
    return { phase: 'off', act: 'none', why: 'the nightly window is switched off', night: null };
  }

  const start = windowStart(o.maintenanceAt, now);
  if (!start) {
    return {
      phase: 'off',
      act: 'none',
      why: `maintenanceAt is ${JSON.stringify(o.maintenanceAt)}, which is not an HH:MM time — the window is off`,
      night: null,
    };
  }

  const night = nightOf(start);
  const max = clampMinutes(o.maintenanceMaxMinutes, MAINTENANCE_DEFAULTS.maintenanceMaxMinutes);
  // Rule 3: the collection's reserved slot at the end of the window. Everything else
  // here is clamped to fit *inside* this, which is the whole of what "reserved" means.
  const lastCall = Math.max(0, max - COLLECT_RESERVE);
  // The drain can never outlast the reserve — not merely the bound. Clamping it to `max`
  // instead was a real bug: a config with `drain: 600, max: 60` produced a drain of 60, a
  // last call of 60, and a night that waited the full hour and then resumed *without
  // collecting*, which is the one outcome rule 3 exists to make impossible. A drain
  // longer than its window is not an error worth refusing — it is somebody who meant
  // "never force" — but it does not get to cost the collection.
  const drain = Math.min(clampMinutes(o.maintenanceDrainMinutes, MAINTENANCE_DEFAULTS.maintenanceDrainMinutes), lastCall);
  const mins = (now - start) / 60000;
  const done = prev.night === night && prev.phase === 'done';
  const mine = prev.night === night ? prev.phase : null;

  /**
   * Outside the window. Two ways to be here — before tonight's start, or after the
   * bound — and they read the same from a dispatch gate's point of view, which is all
   * `idle` means.
   *
   * **`done` is the one phase that must survive being returned, and this is where it
   * used to die.** The caller writes the verdict's phase straight back into its state
   * (`maintenance = { phase: v.phase, … }` in lib/advocate.js), so a verdict of `idle`
   * *erases the memory that tonight already happened*. Both places below used to answer
   * `idle` to a night that was finished, and the next tick — reading `phase: 'idle'`,
   * which is indistinguishable from "nothing has run tonight" — started the whole
   * sequence again from the top: drain, force every open window down, collect, done,
   * idle, drain. On 2026-08-21 that cycle ran all morning, and the visible cost was on
   * the *beads*: bc-7qo.11 was dispatched into it and torn back out 28 times between
   * 05:18Z and 09:55Z, bc-khoe.21 27 times, every one of them archived with 0 commits,
   * because the gap between "collection done, dispatching resumes" and the next
   * re-entry into `closing` is a hole exactly wide enough for a launch. See bc-7qo.19.
   *
   * So a night that is done stays `done` until the clock rolls onto the next one.
   * `holdsDispatch` is false for `done`, so nothing is held by this — the only thing
   * that changes is that the night cannot start itself a second time.
   */
  if (mins >= max) {
    // The bound reached mid-sequence. `resume` rather than a silent drop to idle: the
    // caller has been holding dispatch for two hours and has to be told it may stop.
    if (mine && mine !== 'done') {
      return {
        phase: 'done',
        act: 'resume',
        why:
          mine === 'collecting'
            ? `the collection was still running ${Math.round(mins)}m in — dispatching resumes without waiting for it`
            : `the window ran its full ${max}m without emptying the Mac — dispatching resumes with ${live} window(s) still open`,
        night,
      };
    }
    return done
      ? { phase: 'done', act: 'none', why: 'tonight’s window is over', night }
      : { phase: 'idle', act: 'none', why: 'tonight’s window is over', night };
  }

  if (done) {
    return { phase: 'done', act: 'none', why: 'tonight’s collection is done', night };
  }

  // Inside the window, and it has not finished tonight.

  // A collection already under way. Nothing decides anything while `bd gc` is in
  // flight: the caller clears this by reporting back, and until it does, a second
  // `collect` would be a second gc behind the same gate lock as the first.
  if (mine === 'collecting') {
    return { phase: 'collecting', act: 'none', why: 'the collection is running', night };
  }

  // The Mac is empty — which on a quiet night is true at the very first tick, and
  // there is nothing to drain.
  if (live === 0) {
    return {
      phase: 'collecting',
      act: 'collect',
      why: mine ? 'every window has ended — collecting' : 'nothing was running — collecting',
      night,
    };
  }

  // Still busy, and out of patience: collect over the top of it rather than lose the
  // night. Safe, and rule 3 is the whole argument.
  if (mins >= lastCall) {
    return {
      phase: 'collecting',
      act: 'collect',
      why: `${live} window(s) would not close — collecting anyway, which bd serialises`,
      night,
    };
  }

  // Still busy, and the asking period is over.
  if (mins >= drain) {
    if (o.maintenanceForceClose === false) {
      return {
        phase: 'draining',
        act: 'none',
        why: `${live} window(s) still open after ${Math.round(mins)}m — forcing is switched off, so waiting for the reserve`,
        night,
      };
    }
    return {
      phase: 'closing',
      act: 'force',
      why: `${live} window(s) still open after ${Math.round(mins)}m — closing them`,
      night,
    };
  }

  // Still busy, still inside the asking period. `ask` exactly once, on the way in.
  //
  // `dueIn` travels because the notice has to name it: a session told it has forty minutes
  // lands what it has, and one told only that a window has started carries on working and
  // is signalled mid-thought. See `maintenanceMessage` in lib/session.js.
  return {
    phase: 'draining',
    act: mine === 'draining' || mine === 'closing' ? 'none' : 'ask',
    why: `${live} window(s) finishing — ${Math.max(0, Math.round(drain - mins))}m before they are closed`,
    dueIn: Math.max(0, Math.round(drain - mins)),
    night,
  };
}

/** Does this verdict mean no new session may be opened, anywhere? */
export const holdsDispatch = (v) => v?.phase === 'draining' || v?.phase === 'closing' || v?.phase === 'collecting';

/**
 * One line for the card and the log. Phase first, because that is what a reader is
 * scanning for, and the `why` after it, because that is the half that changes.
 */
export function describe(v) {
  if (!v || v.phase === 'off') return '';
  if (v.phase === 'idle') return '';
  return `maintenance: ${v.phase} — ${v.why}`;
}

/**
 * The collection, per workspace, and what it freed.
 *
 * `--skip-decay` is rule 1 and is not a parameter. `--force` is the confirmation
 * prompt, which an unattended run has nobody to answer.
 *
 * One workspace's failure is not the others': a workspace whose store is mid-write, or
 * whose bd is a version without `gc`, should cost its own line in the report and
 * nothing else. So every result is `{ workspace, ok, detail }` and nothing throws.
 */
export async function collect(bd, workspaces, { timeout = 15 * 60 * 1000, shared = false } = {}) {
  const results = [];
  for (const workspace of workspaces) {
    try {
      /**
       * The shared-tracker gate — `maintenanceCollectShared` above is the whole argument.
       *
       * Asked per workspace per night rather than cached: whether a tracker is shared is a
       * fact about the tracker that somebody can change with one `bd dolt remote add`, and
       * the direction of the mistake matters. A workspace that *became* shared since the
       * last run must be skipped tonight, and a cache would collect it once first.
       *
       * A `doltRemote` that throws is treated as "shared", not as "not shared". A workspace
       * whose remote cannot be *listed* is one to leave alone — `doltRemote` itself returns
       * null for a malformed answer, so a throw here is bd failing outright, and collecting
       * a store we could not ask a question about is the wrong side of this trade.
       */
      if (!shared) {
        let remote;
        try {
          remote = await bd.doltRemote(workspace);
        } catch (err) {
          results.push({
            workspace: workspace.name,
            ok: true,
            skipped: true,
            detail: `skipped — could not tell whether it is shared (${err.message.split('\n')[0]})`,
          });
          continue;
        }
        if (remote) {
          results.push({
            workspace: workspace.name,
            ok: true,
            skipped: true,
            detail: `skipped — shared with ${remote.name}${remote.url ? ` (${remote.url})` : ''}; set maintenanceCollectShared to include it`,
          });
          continue;
        }
      }
      const out = await bd.gc(workspace, { timeout });
      results.push({ workspace: workspace.name, ok: true, detail: freedFrom(out) });
    } catch (err) {
      results.push({ workspace: workspace.name, ok: false, detail: err.message.split('\n')[0] });
    }
  }
  return results;
}

/**
 * The one line worth keeping out of `bd gc`'s eleven.
 *
 * It prints its own summary — `Dolt GC: complete: 825.3 MB → 298.7 MB (freed 526.6 MB)`
 * — and that sentence is the whole outcome, so it is lifted rather than reformatted: a
 * number this file computed itself would be a second opinion about a measurement bd
 * already took. Anything unrecognised falls back to "collected", because a gc that
 * worked and phrased itself differently is still a gc that worked.
 */
export function freedFrom(out) {
  const line = String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^Dolt GC:/i.test(l));
  return line ? line.replace(/^Dolt GC:\s*/i, '') : 'collected';
}
