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
 * The filter outlives the config it was picked under — it sits in state.json across
 * restarts and reconfigurations — so a renamed space, a dropped workspace, or a
 * workspace moved between spaces are all reachable states. Each one shows the same
 * way without this: a list filtered to nothing, no chip pressed to explain it, and no
 * way back other than guessing that "All" is the fix.
 *
 * The inbox reconciles the same two fields on its own, and that is not redundant with
 * this. The push path reads the filter straight out of state.json inside the server
 * poll, with no client anywhere in the loop to correct it — a stale value there is a
 * decision about whether your phone rings, not a chip drawn wrong.
 *
 * **An empty list means "not configured", never "everything vanished."** `summarise`
 * returns `[]` when no spaces are set up at all, and in that state the space row is
 * never even drawn; resetting a saved value on that basis would be guessing rather
 * than reconciling. Same for a server with no workspaces yet.
 *
 * `spaces` is `summarise()`'s output rather than `cfg.spaces`, deliberately: the
 * synthetic "Other" group is a space you can filter by, and validating against the
 * config alone would drop it every time.
 */
export function reconcileFilter(spaces, workspaces, filter) {
  const name = (v) => (typeof v === 'string' && v ? v : 'all');
  const wantSpace = name(filter?.space);
  const wantWs = name(filter?.workspace);

  const known = (list, v) => !list?.length || list.includes(v);

  const rows = spaces || [];
  const space = wantSpace === 'all' || known(rows.map((s) => s.name), wantSpace) ? wantSpace : 'all';
  // Only if the space itself survived: a workspace is judged against the space that is
  // actually filtering, and a space that fell back to All stops constraining anything.
  const row = space === wantSpace ? rows.find((s) => s.name === wantSpace) : null;

  const lives = known(workspaces, wantWs);
  // Live at all, and living inside the filtered space. A workspace that has moved out
  // of it names something real, pairs with something real, and together they match
  // nothing — which is the empty list this exists to prevent.
  const inSpace = !row || (row.workspaces || []).includes(wantWs);
  const workspace = wantWs === 'all' || (lives && inSpace) ? wantWs : 'all';

  return { space, workspace };
}

/**
 * Is this bead inside the inbox filter — the same two-level test the list applies?
 *
 * Space first, then workspace within it, and `all` on either half means that half
 * constrains nothing. A bead in no configured space answers to "Other", exactly as
 * the inbox's own `spaceOf` does; the two must agree, or the phone would go quiet
 * for a bead it is showing you.
 *
 * Takes a reconciled filter. An unreconciled one that names a space nobody has any
 * more matches nothing at all, and "nothing matches" here does not mean an empty
 * list — it means silence.
 */
export function matchesFilter(filter, q) {
  const space = filter?.space || 'all';
  const workspace = filter?.workspace || 'all';
  if (space !== 'all' && (q?.space || 'Other') !== space) return false;
  if (workspace !== 'all' && q?.workspace !== workspace) return false;
  return true;
}

/**
 * Why this bead is not allowed to make a noise — `'filtered'`, `'muted'`, or null
 * when it may.
 *
 * The single place either answer is decided, so the question push, the foundation
 * request push and the reply push cannot drift apart on it. Both answers mean the
 * same thing to everything downstream: the event is still emitted, the card still
 * files, the badge still counts — the phone just stays dark. Filtering must never
 * lose a bead, only quieten it, which is the contract a muted space already has.
 *
 * The filter is tested first, and the order is the reason rather than a tie-break:
 * a filter is a thing you set a minute ago and can see pressed on the screen, so it
 * is the more useful of the two to be told about at 2am. A bead that is both outside
 * the filter and inside a muted space reads as filtered, and would stay quiet on
 * either count anyway.
 */
export function quietReasonFor(cfg, filter, q, now = new Date()) {
  if (!matchesFilter(filter, q)) return 'filtered';
  if (isQuiet(spaceFor(cfg, q.workspace), now)) return 'muted';
  return null;
}

/** "Personal / sophab" — what a filter is set to, for the log line that says so. */
export function describeFilter(filter) {
  const parts = [filter?.space, filter?.workspace].filter((v) => v && v !== 'all');
  return parts.length ? parts.join(' / ') : 'all';
}
