/**
 * Spaces — groups of workspaces that share a notification policy.
 *
 * The point is not tidiness, it's interruption. "Keep work separate" almost always
 * means "don't buzz me about work at the weekend", so a space is defined by *when
 * it is allowed to reach you*, and the grouping in the UI falls out of that.
 *
 * A muted space is never silent about its existence: its questions still arrive,
 * still appear in the list, still carry a badge count. It just doesn't make the
 * phone light up. Losing a question would be a far worse bug than an unwanted ping.
 *
 * Config shape:
 *
 *   "spaces": [
 *     { "name": "Personal", "workspaces": ["notes", "sideproject"] },
 *     { "name": "Work", "workspaces": ["acme"],
 *       "quietHours": { "from": "18:00", "to": "09:00" },
 *       "quietDays": ["sat", "sun"],
 *       "ntfyDetail": "minimal",
 *       "autoDispatch": false }
 *   ]
 *
 * Everything except `name` and `workspaces` is optional.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "18:00" → 1080. Null for anything unparseable, so a typo disables the rule
 *  rather than silently muting a space forever. */
function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The space a workspace belongs to, or null when spaces aren't configured. */
export function spaceFor(cfg, workspaceName) {
  return (cfg.spaces || []).find((s) => (s.workspaces || []).includes(workspaceName)) || null;
}

/**
 * Is this space currently not allowed to interrupt?
 *
 * Evaluated per push rather than cached, because the answer changes on a clock.
 * Uses local time on purpose: "after 6pm" means the user's evening, not UTC.
 */
export function isQuiet(space, now = new Date()) {
  if (!space) return false;
  if (space.muted) return true;

  const quietDays = (space.quietDays || []).map((d) => String(d).slice(0, 3).toLowerCase());
  if (quietDays.includes(DAYS[now.getDay()])) return true;

  const from = minutesOfDay(space.quietHours?.from);
  const to = minutesOfDay(space.quietHours?.to);
  if (from === null || to === null) return false;

  const mins = now.getHours() * 60 + now.getMinutes();
  // from > to means the window crosses midnight (18:00 → 09:00), which is the
  // normal case for "evenings and overnight".
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

/**
 * When does this space stop being quiet? A Date, or null if it isn't quiet — or is
 * muted, which has no end.
 *
 * Only two kinds of moment can change the answer: the end of a quiet-hours window,
 * and midnight, which is where `quietDays` flips. So the boundaries are tested
 * directly rather than the clock being scanned minute by minute, and the two rules
 * interacting — quiet until 09:00 on a Monday that follows a quiet Sunday — falls
 * out for free instead of needing its own case.
 *
 * The dates are built through the local-time constructor rather than by adding
 * milliseconds, so a quiet window spanning a DST change still ends at the wall
 * clock time it was configured with.
 */
export function quietUntil(space, now = new Date()) {
  if (!space || space.muted || !isQuiet(space, now)) return null;
  const to = minutesOfDay(space.quietHours?.to);

  const candidates = [];
  // Eight days: enough that even "quiet every day except one" resolves.
  for (let d = 0; d <= 8; d++) {
    const day = [now.getFullYear(), now.getMonth(), now.getDate() + d];
    candidates.push(new Date(...day, 0, 0, 0, 0));
    if (to !== null) candidates.push(new Date(...day, Math.floor(to / 60), to % 60, 0, 0));
  }

  return (
    candidates
      .filter((t) => t > now)
      .sort((a, b) => a - b)
      .find((t) => !isQuiet(space, t)) || null
  );
}

/** Convenience: is the space owning this workspace quiet right now? */
export function isWorkspaceQuiet(cfg, workspaceName, now = new Date()) {
  return isQuiet(spaceFor(cfg, workspaceName), now);
}

/**
 * Per-space overrides, falling back to the global config.
 *
 * `ntfyDetail: "minimal"` on a space does the same job as listing every one of its
 * workspaces in `ntfy.minimalWorkspaces`, but survives adding a new workspace to
 * the space — which is exactly the kind of drift that leaks a work question onto a
 * public relay.
 */
export function ntfyDetailFor(cfg, workspaceName) {
  const space = spaceFor(cfg, workspaceName);
  if ((cfg.ntfy?.minimalWorkspaces || []).includes(workspaceName)) return 'minimal';
  if (space?.ntfyDetail) return space.ntfyDetail;
  return cfg.ntfy?.detail || 'full';
}

/** Whether an unattended agent may answer comments in this workspace. */
export function autoDispatchAllowed(cfg, workspaceName) {
  if (cfg.autoDispatch === false) return false;
  if ((cfg.autoDispatchExclude || []).includes(workspaceName)) return false;
  const space = spaceFor(cfg, workspaceName);
  return space?.autoDispatch !== false;
}

/**
 * What the phone needs to draw the space row: every configured space, plus a
 * synthetic one for workspaces nobody assigned. The stray group only appears when
 * it has something in it, so a fully-assigned setup shows a clean row.
 */
export function summarise(cfg, questions) {
  const spaces = cfg.spaces || [];
  if (!spaces.length) return [];

  const assigned = new Set(spaces.flatMap((s) => s.workspaces || []));
  const now = new Date();

  const rows = spaces.map((s) => ({
    name: s.name,
    workspaces: s.workspaces || [],
    quiet: isQuiet(s, now),
    muted: Boolean(s.muted),
    count: questions.filter((q) => (s.workspaces || []).includes(q.workspace)).length,
  }));

  const strays = questions.filter((q) => !assigned.has(q.workspace));
  if (strays.length) {
    rows.push({
      name: 'Other',
      workspaces: [...new Set(strays.map((q) => q.workspace))],
      quiet: false,
      muted: false,
      count: strays.length,
    });
  }
  return rows;
}

/**
 * A saved inbox filter, checked against the setup that exists *now*.
 *
 * The filter outlives the config that it was picked under — it sits in state.json
 * across restarts and reconfigurations — so a space that was renamed, a workspace
 * that was dropped, or a workspace that moved to another space all end the same way
 * without this: a list filtered to nothing, no chip pressed to say why, and no
 * obvious way back other than guessing that the "All" chip is the fix.
 *
 * Each half falls back to `all` on its own. A space that disappeared does not throw
 * away a workspace choice that still names a live workspace — that is still a filter
 * you can read off the screen.
 *
 * `spaces` is `summarise()`'s output rather than `cfg.spaces`, deliberately: the
 * synthetic "Other" group is a space you can filter by, and validating against the
 * config alone would drop it every time.
 */
export function reconcileFilter(spaces, workspaces, filter) {
  const str = (v) => (typeof v === 'string' && v ? v : 'all');
  const wantSpace = str(filter?.space);
  const wantWs = str(filter?.workspace);

  const row = (spaces || []).find((s) => s.name === wantSpace);
  const space = row ? wantSpace : 'all';
  // Live at all, and — when a space is also picked — living inside it. A workspace
  // that has moved out of the filtered space matches nothing, which is the empty
  // list this exists to prevent.
  const live = (workspaces || []).includes(wantWs) && (!row || (row.workspaces || []).includes(wantWs));
  return { space, workspace: live ? wantWs : 'all' };
}
