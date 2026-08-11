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
 *       "autoDispatch": false,
 *       "autoEndorse": false,
 *       "autoMerge": false,
 *       "requireApproval": true,
 *       "autoShip": false }
 *   ]
 *
 * Everything except `name` and `workspaces` is optional.
 *
 * The last four are not about interruption, and they are here anyway: whether a bead an
 * agent filed may be worked without you having looked at it, whether a worker merges its
 * own pull request, whether an approving review is required before it may, and whether
 * the merge then deploys itself, are the same kind of answer as "may an agent reply to
 * this unasked" — one you give once for a group of repos rather than per repo. See
 * `autoEndorseAllowed`, `prPolicyFor` and `autoShipAllowed` below.
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

/**
 * The space a workspace belongs to, or null when spaces aren't configured.
 *
 * `cfg?.` rather than `cfg.`: every resolver below funnels through here, and a policy
 * question asked with no config in hand should answer "no space, so the default" rather
 * than throwing. `spaceDetail` has read it that way since it was written; a caller
 * reaching one of the booleans first used to get a TypeError instead.
 */
export function spaceFor(cfg, workspaceName) {
  return (cfg?.spaces || []).find((s) => (s.workspaces || []).includes(workspaceName)) || null;
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
 * May a bead an agent filed in this workspace be worked without you having looked at it?
 *
 * The hold in lib/endorse.js is beadcause's most conservative default and it is the right
 * one: an agent decided there was work here, and an hour of unattended agent on work
 * nobody has read is exactly what `unendorsed` was invented to stop. But "the right
 * default" and "the right answer everywhere" are different claims, and they come apart
 * per *space* in the same way `autoMerge` does. A personal side project where the only
 * reader of the tracker is the person who would have tapped Endorse is paying a tap per
 * discovery for a review that is not happening; a repo other people read wants every
 * filing looked at, and would rather the queue sat there than move on its own.
 *
 * So this is per space, and — unlike everything else here — **its global default is
 * off**. The two other booleans default to the permissive answer because their worst case
 * is a notification you did not want or a merge you would have made anyway. The worst
 * case here is a session opened on work you have never seen, which is the one thing
 * lib/endorse.js exists to make impossible, so it may only ever happen because you asked
 * for it in as many words. `cfg.autoEndorse === true` rather than `!== false`.
 *
 * A space may still override it in either direction, like the PR policy and unlike
 * `autoDispatchAllowed`'s veto: "on everywhere except the shared repo" needs a global
 * `true` a space can say `false` to, and refusing that would leave the only way to
 * express it as a list of every other space.
 *
 * What this does *not* change: the priority clamp, the `agent-filed` label and the
 * `discovered-from` edge all still go on (lib/filing.js), so an auto-endorsed bead is
 * still capped at P2, still findable by one `bd list --label agent-filed`, and still
 * carries the bead it was discovered under. Auto-endorsement drops the hold, not the
 * provenance — the audit is the whole of what is left, and it has to survive.
 */
export function autoEndorseAllowed(cfg, workspaceName) {
  const space = spaceFor(cfg, workspaceName);
  return typeof space?.autoEndorse === 'boolean' ? space.autoEndorse : cfg?.autoEndorse === true;
}

/**
 * Does a worker in this workspace merge its own pull request, and must someone have
 * approved it first?
 *
 * Both halves used to be one global answer — `cfg.pr.autoMerge`, on by default, the
 * same for every repo in every space. That is wrong at the edges in both directions
 * and the wrongness is per *space*, not per repo: a personal side project wants its
 * work landed without being asked at three in the morning, and anything with other
 * people on it wants eyes on the diff before it is in `main`. A space is already the
 * unit for exactly this kind of policy.
 *
 * Two things are worth being explicit about.
 *
 * **The global is a default here, not a veto** — which is the one way this differs
 * from `autoDispatchAllowed` above. There, `autoDispatch: false` is a safety switch
 * ("no unattended agent answers anything, anywhere") and a space must not be able to
 * talk its way out of it. Here both answers are ordinary policy, and only a default
 * a space can override in *either* direction can express the two setups that
 * motivated this: on everywhere except the shared repo, and off everywhere except
 * the side project. So an explicit boolean on the space wins, and a space that says
 * nothing inherits.
 *
 * **Resolved together, and read together.** `bin/deliver.js` decides whether to
 * merge and `lib/session.js` writes the brief promising what that command will do;
 * a brief promising a merge to a session whose delivery then files a question is how
 * you get a window reporting work as landed over a bead that says otherwise. One
 * helper returning both means the two cannot drift apart on either.
 *
 * There is deliberately no per-workspace exclude list beside these, unlike
 * `autoDispatchExclude`: that one exists because a *shared tracker* must never be
 * auto-answered whatever space it lands in, and no equivalent safety property holds
 * here — anything a repo needs, the space it sits in can say.
 */
export function prPolicyFor(cfg, workspaceName) {
  const space = spaceFor(cfg, workspaceName);
  // `typeof` rather than `??`, because the only values that may override are real
  // booleans. A space carrying `autoMerge: "false"` from a hand-edited config asked
  // for nothing legible, and inheriting is the safer reading of an unreadable one.
  const own = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  return {
    autoMerge: own(space?.autoMerge, cfg.pr?.autoMerge !== false),
    // Only meaningful while `autoMerge` is on: with it off every delivery is already a
    // question, and an approval is what answering it *is*.
    requireApproval: own(space?.requireApproval, cfg.pr?.requireApproval === true),
  };
}

/**
 * Does a merge in this workspace deploy itself, without waiting for a tap?
 *
 * The third policy answer a space gives, and the one with teeth. A ship bead says
 * "merged, not live" and then waits for **Ship** on the pull request board, so merged
 * work sits on `origin/main` for as long as it takes to be noticed. With this on, the
 * release queue runs the repo's own declared deploy instead — see lib/release.js for the
 * settle window that makes four merges one deploy, and lib/autoship.js for the epic that
 * may override this in either direction.
 *
 * **The global default is off, and it is a default rather than a veto.** Off is what
 * every install does today, and an upgrade must not start restarting daemons on its own.
 * But a space saying `true` beats it, exactly as `autoMerge` does: the two setups this
 * has to express are "everywhere except the shared repo" and "nowhere except the side
 * project", and only an overridable default can say both.
 *
 * Note what `false` does *not* buy, because it is a property of deploying rather than a
 * gap here: a deploy makes everything on `origin/main` live at once, so a merge in a
 * space set to `false` still goes live the moment something else fires a deploy of that
 * checkout. What `false` guarantees is that nothing in this space is ever the *reason* a
 * deploy ran — which is the same guarantee the Ship button gives today.
 */
export function autoShipAllowed(cfg, workspaceName) {
  const space = spaceFor(cfg, workspaceName);
  // `typeof` rather than `??`, for the reason `prPolicyFor` gives: only a real boolean
  // is an override, and an unreadable one inherits.
  if (typeof space?.autoShip === 'boolean') return space.autoShip;
  return cfg?.release?.autoShip === true;
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
 *
 * **A foundation request is never `'filtered'`, and that is a decision rather than an
 * omission** (bc-8on). The filter's two levels are space and workspace, and both are
 * answers to "which of my lives is this about" — a question a constitutional request
 * has no answer to. It is the same chat session whichever repo it happened to be
 * working in when it hit the wall, which is exactly why the inbox draws that channel
 * above the list and outside every filter on it (`requestsHtml` in public/app.js), and
 * why the filter-change prompt leaves those notifications alone (`excludedRinging` in
 * lib/ringing.js). Two of the three surfaces already said the filter does not reach
 * this channel; the push was the outlier, and honouring the filter here bought the
 * one state the filter contract exists to prevent — a request sitting *visible* on the
 * screen and silent on the phone, with no widening left to do that would bring it
 * back, because it was never hidden in the first place.
 *
 * A mute still applies to it, and the asymmetry is the point: a mute answers "may
 * anything reach me right now", which is about you rather than about which life the
 * bead belongs to, and an agent asking to be different has been waiting for a session
 * anyway — it can wait for the evening to end. See the block over the push loop in
 * lib/server.js for why that override is not worth taking either.
 */
export function quietReasonFor(cfg, filter, q, now = new Date()) {
  if (!q?.foundation && !matchesFilter(filter, q)) return 'filtered';
  if (isQuiet(spaceFor(cfg, q.workspace), now)) return 'muted';
  return null;
}

/** "Personal / sophab" — what a filter is set to, for the log line that says so. */
export function describeFilter(filter) {
  const parts = [filter?.space, filter?.workspace].filter((v) => v && v !== 'all');
  return parts.length ? parts.join(' / ') : 'all';
}

/* ======================================================================= settings

   Every field above is something you set by opening `~/.beadcause/config.json` in an
   editor, on the Mac, with the daemon running. That was tolerable while a space was
   two lines of quiet hours you wrote once. It stopped being tolerable when a space
   became the unit that decides whether an agent may answer unasked (`autoDispatch`)
   and whether a worker merges its own pull request without you (`autoMerge`,
   `requireApproval`) — those are answers you change *because of something you are
   looking at*, from wherever you are looking at it, and a policy you can only change
   at a keyboard is a policy that stays wrong until you are next at one.

   So the space details screen writes them, and these two functions are the whole of
   what it is allowed to write. Three properties they are shaped around:

   **What the screen shows is what the daemon reads.** `readSettings` reports a field
   as set only if the readers above would actually honour it — a hand-typed `"18:0"`
   is `null` here for the same reason `minutesOfDay` returns null for it, because a
   screen saying "quiet 18:0–09:00" over a daemon that is quiet at no time at all is
   worse than one saying there are no quiet hours.

   **`null` is a real value, and it means "inherit".** Every field but `muted` and
   `quietDays` has a global default behind it, and `prPolicyFor` is explicit that a
   space may override it in *either* direction — so "off" and "not set" are different
   answers and the wire has to be able to say both. Deleting the key is how a space
   goes back to following the global, and it is the only way back.

   **Nothing here writes to disk.** `applySettings` mutates the space object it is
   given and stops; persisting is the caller's job, and it matters that it is, because
   the object being mutated is the live `cfg` the running daemon reads on every push.
   The write to the file and the change of behaviour are two halves of one act, and a
   caller that did only the first would leave the daemon acting on the old answer
   until it next restarted.
*/

/** The fields a space details screen may set. Anything else in a patch is refused. */
export const SETTINGS = [
  'muted',
  'quietHours',
  'quietDays',
  'ntfyDetail',
  'autoDispatch',
  'autoEndorse',
  'autoMerge',
  'requireApproval',
  'autoShip',
];

const DETAILS = ['full', 'minimal'];

/** "9:00" → "09:00". Null for anything the readers above would ignore. */
function normalHour(hhmm) {
  const mins = minutesOfDay(hhmm);
  if (mins === null) return null;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** Day names in any spelling → the canonical three letters, in week order, deduped. */
function normalDays(list) {
  const want = new Set(
    (Array.isArray(list) ? list : []).map((d) => String(d).slice(0, 3).toLowerCase()).filter((d) => DAYS.includes(d))
  );
  return DAYS.filter((d) => want.has(d));
}

const bool = (v) => (typeof v === 'boolean' ? v : null);

/**
 * What this space actually says, field by field, with `null` for every one it leaves
 * to the global default.
 *
 * Deliberately not `{...space}`: a space also carries `name` and `workspaces`, which
 * are the two things this screen must never edit — moving a repo between spaces
 * changes which questions are allowed to reach you at all, and that is a config-file
 * act, not a toggle.
 */
export function readSettings(space) {
  const from = normalHour(space?.quietHours?.from);
  const to = normalHour(space?.quietHours?.to);
  const days = normalDays(space?.quietDays);
  return {
    muted: bool(space?.muted),
    quietHours: from && to ? { from, to } : null,
    quietDays: days.length ? days : null,
    ntfyDetail: DETAILS.includes(space?.ntfyDetail) ? space.ntfyDetail : null,
    autoDispatch: bool(space?.autoDispatch),
    autoEndorse: bool(space?.autoEndorse),
    autoMerge: bool(space?.autoMerge),
    requireApproval: bool(space?.requireApproval),
    autoShip: bool(space?.autoShip),
  };
}

/**
 * Apply a patch to a space, in place. Returns the fields that actually changed.
 *
 * Only the keys present are touched, so a screen may send one field per press and
 * never has to read-modify-write the whole object — which is what stops a phone and
 * a laptop, each a poll behind the other, clobbering unrelated settings.
 *
 * Throws on anything it does not understand rather than dropping it. A setting
 * silently ignored is the failure this screen exists to end: you press the button,
 * the screen redraws, and the daemon goes on doing exactly what it did.
 */
export function applySettings(space, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');

  const unknown = Object.keys(patch).filter((k) => !SETTINGS.includes(k));
  if (unknown.length) throw new Error(`not a space setting: ${unknown.join(', ')}`);

  const before = readSettings(space);

  for (const [key, raw] of Object.entries(patch)) {
    // `null` is how the screen says "go back to the global default", and for the two
    // fields with no global behind them it is simply "no".
    const clear = raw === null;

    if (key === 'quietHours') {
      if (clear) {
        delete space.quietHours;
        continue;
      }
      const from = normalHour(raw?.from);
      const to = normalHour(raw?.to);
      if (!from || !to) throw new Error('quietHours needs a from and a to, each HH:MM');
      space.quietHours = { from, to };
    } else if (key === 'quietDays') {
      if (clear) {
        delete space.quietDays;
        continue;
      }
      if (!Array.isArray(raw)) throw new Error('quietDays must be a list of day names');
      const days = normalDays(raw);
      // A list with something unreadable in it is refused rather than quietly stored as
      // the days that did parse: "sat, funday" would otherwise turn a two-day rule into
      // a one-day one and report success.
      const asked = new Set(raw.map((d) => String(d).slice(0, 3).toLowerCase()));
      if (days.length !== asked.size) throw new Error(`quietDays must be day names — ${DAYS.join(', ')}`);
      if (days.length) space.quietDays = days;
      else delete space.quietDays;
    } else if (key === 'ntfyDetail') {
      if (clear) {
        delete space.ntfyDetail;
        continue;
      }
      if (!DETAILS.includes(raw)) throw new Error(`ntfyDetail must be ${DETAILS.join(' or ')}`);
      space.ntfyDetail = raw;
    } else {
      // The six booleans — muted, autoDispatch, autoEndorse, autoMerge, requireApproval,
      // autoShip.
      if (clear) {
        delete space[key];
        continue;
      }
      if (typeof raw !== 'boolean') throw new Error(`${key} must be true, false or null`);
      space[key] = raw;
    }
  }

  const after = readSettings(space);
  return SETTINGS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/**
 * Everything the space details screen draws about one space: what it says, what that
 * currently means, and what each repo inside it actually resolves to.
 *
 * Null for a name that is not a configured space — including the synthetic `Other`,
 * which is a group the picker offers and not a thing with settings. A screen asked to
 * configure it has to say so rather than draw nine controls that write nowhere.
 *
 * The three parts are three different claims and the screen needs all of them:
 *
 * - **`settings`** is what the config file says, `null` per field for "inherit". It is
 *   what the controls are set from, and the only thing a write changes.
 * - **`defaults`** is what each of those inherits *to*, so a control reading `Inherit`
 *   can say what that means today rather than leaving you to guess.
 * - **`repos`** is the answer the daemon would actually give, per workspace, through
 *   the same six resolvers every other caller uses. It exists because the space is
 *   not the last word on two of these: `ntfy.minimalWorkspaces` and
 *   `autoDispatchExclude` are per-repo lists that outrank it, so a space set to
 *   `full` can contain a repo that pushes minimally. A screen that showed only the
 *   space's own answer would be quietly wrong about that repo, and it would be wrong
 *   in the direction of promising you more detail on your phone than you will get.
 */
export function spaceDetail(cfg, name, now = new Date()) {
  const space = (cfg?.spaces || []).find((s) => s.name === name);
  if (!space) return null;

  const configured = new Set((cfg?.workspaces || []).map((w) => w.name));
  // Only repos this daemon actually has. A space naming a checkout that has since gone
  // is config drift, and offering to reason about it would be inventing a repo.
  const inside = (space.workspaces || []).filter((w) => configured.has(w));
  const until = quietUntil(space, now);

  return {
    space: space.name,
    workspaces: inside,
    // Named, so the screen can say which repos in the space are missing rather than
    // silently listing fewer than the config does.
    missing: (space.workspaces || []).filter((w) => !configured.has(w)),
    settings: readSettings(space),
    effective: {
      muted: Boolean(space.muted),
      quiet: isQuiet(space, now),
      quietUntil: until ? until.toISOString() : null,
    },
    repos: inside.map((w) => ({
      name: w,
      ntfyDetail: ntfyDetailFor(cfg, w),
      autoDispatch: autoDispatchAllowed(cfg, w),
      autoEndorse: autoEndorseAllowed(cfg, w),
      autoShip: autoShipAllowed(cfg, w),
      ...prPolicyFor(cfg, w),
    })),
    defaults: {
      ntfyDetail: cfg?.ntfy?.detail || 'full',
      // The global here really is a veto rather than a default — see
      // `autoDispatchAllowed` — so a space that says nothing still gets `false` when
      // the global is off, and the screen has to be able to say why.
      autoDispatch: cfg?.autoDispatch !== false,
      // The one default that is off unless asked for in as many words: an Inherit button
      // here has to read "Inherit (off)" on a fresh install, because the hold is the
      // shipped behaviour and a screen implying otherwise is a screen promising a queue
      // that is not there. See `autoEndorseAllowed`.
      autoEndorse: cfg?.autoEndorse === true,
      autoMerge: cfg?.pr?.autoMerge !== false,
      requireApproval: cfg?.pr?.requireApproval === true,
      // Off unless the config says otherwise, which is today's behaviour everywhere:
      // a merge waits for the Ship button. See `autoShipAllowed`.
      autoShip: cfg?.release?.autoShip === true,
    },
  };
}
