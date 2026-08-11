/**
 * Current sessions — what every agent is on, across every workspace.
 *
 * The inbox answers "what needs *me*". This answers the other question — what did
 * the sessions I'm not watching get up to — which until now was invisible from the
 * phone: a bead only reaches the inbox if it carries the `human` label, so nine
 * beads claimed in sophab five minutes ago showed up nowhere at all.
 *
 * A session shows up here through either of two independent signals, and it matters
 * that they are independent:
 *
 * - **A claimed bead** — `status = in_progress`. This is the signal every session
 *   already emits, because claiming work *is* `bd update --claim`; it needs no
 *   cooperation from the agent, no hook, and no beadcause-specific convention. Live
 *   phase and detail (status.json, `/api/status`) layer on where they exist, but
 *   their absence is normal rather than a gap — most sessions never post one. This
 *   is the half that says *which bead*.
 * - **A live Claude Code process** — see lib/claude.js. This is the half that catches
 *   a session which has claimed nothing, and so appears nowhere in the tracker.
 *
 * They are reported side by side and never merged: nothing on this machine records
 * which bead a given process is on, so pairing them would be a guess dressed up as
 * a fact. A workspace with two sessions and no claimed bead is a real and useful
 * thing to see, and it is precisely what a guess would have hidden.
 */
import { PHASES } from './activity.js';

/** Trim `adam.morgan@climative.ai` down to something that fits a phone. */
export const shortActor = (s) => String(s || '').split('@')[0] || '';

/**
 * One workspace's picture. Three `bd` calls, in parallel: counts, the claimed beads,
 * and the ones held for endorsement.
 *
 * The third exists because `ready` is a number someone acts on. `bd status` counts a
 * bead held for endorsement as ready — it is ready in every way except the one that
 * matters, since nothing may open a session on it (lib/endorse.js) — so a monitor
 * quoting it raw would say "9 ready" over a queue of 4 and explain none of the
 * difference. So the held ones come out of `ready` and are reported as their own
 * number, which is the honest shape: work waiting on you, not work waiting on nobody.
 *
 * That call is the only one allowed to fail quietly. `bd ready --label` is the newest
 * thing here, and an older `bd` that refuses the combination should cost this row a
 * held count, not turn the whole workspace into an error row.
 *
 * A workspace that fails — a database mid-write, a workspace directory that has
 * gone away — reports its error rather than vanishing from the list. A missing row
 * would read as "nothing happening there", which is the one thing it doesn't mean.
 */
async function forWorkspace(bd, ws, store, sessions = []) {
  const mine = sessions.filter((s) => s.workspace === ws.name);
  try {
    const [summary, rows, held] = await Promise.all([
      bd.status(ws),
      bd.listStatus(ws, 'in_progress'),
      bd.readyHeld(ws).catch(() => []),
    ]);
    const working = rows.map((r) => {
      const key = `${ws.name}/${r.id}`;
      const live = store[key];
      // `agent:<phase>` is the cross-session signal — any tool can set it with
      // `bd set-state`, where status.json only knows what came through beadcause.
      const labelled = (r.labels || []).find((l) => l.startsWith('agent:'));
      const phase = live?.phase || (labelled ? labelled.slice(6) : null);
      return {
        id: r.id,
        title: r.title,
        priority: r.priority ?? null,
        actor: shortActor(r.assignee || r.owner),
        since: r.started_at || r.updated_at || r.created_at || null,
        phase: phase && phase !== 'idle' ? phase : null,
        icon: phase ? PHASES[phase]?.icon || '•' : null,
        detail: live?.detail || '',
      };
    });
    // Longest-running first: a bead claimed six hours ago is the interesting one.
    working.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
    return {
      name: ws.name,
      working,
      sessions: mine,
      counts: {
        open: summary?.open_issues ?? null,
        // Never below zero: the two numbers come from two calls a moment apart, and a
        // bead endorsed in between would otherwise show as "-1 ready".
        ready: summary?.ready_issues == null ? null : Math.max(0, summary.ready_issues - held.length),
        held: held.length,
        blocked: summary?.blocked_issues ?? null,
        inProgress: summary?.in_progress_issues ?? working.length,
        // What has been finished here. Free — `bd status` has always carried
        // `closed_issues` and this row has always called it, so surfacing it costs no
        // fourth `bd` invocation — and it is the door to /history for the same reason
        // `held` is the door to /endorse: the count you were already reading is what
        // opens the list behind it. Every other number on this row is work that is not
        // done, which is exactly why this one needed somewhere to go.
        closed: summary?.closed_issues ?? null,
      },
    };
  } catch (err) {
    // The sessions are still reported: they come from the filesystem, not from bd,
    // so a workspace whose database is mid-write can still tell you someone is in it.
    return { name: ws.name, working: [], sessions: mine, counts: {}, error: err.message.split('\n')[0] };
  }
}

export async function collectWork(bd, workspaces, store = {}, sessions = []) {
  const spaces = await Promise.all(workspaces.map((ws) => forWorkspace(bd, ws, store, sessions)));
  // Busiest first, then alphabetical — the ones with something happening in them are
  // why you opened this. A session counts as busy even with no bead claimed, which is
  // the whole reason it is here.
  spaces.sort(
    (a, b) =>
      b.working.length + b.sessions.length - (a.working.length + a.sessions.length) ||
      a.name.localeCompare(b.name)
  );
  return spaces;
}
