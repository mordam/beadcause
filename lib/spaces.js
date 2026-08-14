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
 * `autoEndorseAllowed`, `prPolicyFor` and `autoShipAllowed` below, and the block above
 * `autoDispatchAllowed` for why that stays true now a workspace can be many repos.
 *
 * **`autoEndorse` is the exception to that grouping, and it is deliberate.** The others
 * group cleanly: "don't buzz me about work at the weekend" and "don't land a diff other
 * people read without eyes on it" are properties of a *set* of repos, and a space is that
 * set. The hold is not. The reason to drop it — I am the only reader of this tracker and
 * the tap is not a review — is a fact about one workspace, and it stops being true of the
 * workspace beside it in the same space without either of them moving. So it has a
 * per-workspace override that outranks the space, the way `ntfy.minimalWorkspaces` and
 * `slack.excludeWorkspaces` already outrank it for notification detail:
 *
 *   "autoEndorsePerWorkspace": { "beadcause": true, "sophab": false }
 *
 * Keyed by workspace name, like `jira`, `sessionDirs` and `advocates.perWorkspace`, and
 * deliberately **not** a field on a `workspaces` entry — that array is discovered from
 * `~/beads/*​/.beads` and reconciled on every start (lib/config.js), so anything written
 * onto it by hand is gone at the next restart. A name that is absent from the map
 * inherits; only a real boolean overrides. See `autoEndorseAllowed`.
 *
 * Note the grain, because it is the whole of why this and the block above
 * `autoDispatchAllowed` agree rather than contradict: the exception is *between*
 * workspaces in one space, never *inside* one. "Who else reads this graph, and would they
 * mind an agent acting on it unasked" is exactly the question that block settles at the
 * workspace, and a workspace of forty org checkouts still gets one answer.

 */
import { multiRepo, repoList } from './repos.js';
// Imports nothing itself, so this cannot start a cycle whatever else grows here.
import { addressedElsewhere } from './addressee.js';

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

/**
 * Which Slack channel a question in this workspace is posted to, or `null` for none.
 *
 * The same shape as `ntfyDetailFor` above, and for the same reason: what decides
 * whether a repo may reach you is the space, because that is where "keep work out of my
 * evening" already lives. A per-workspace answer would drift the moment a repo joined a
 * space, and the drift here is not a missing buzz — it is a question from a private side
 * project appearing in a channel other people read.
 *
 * Three ways to answer, and the order is the point:
 *
 * - **`slack.excludeWorkspaces`** is the per-repo veto, exactly like
 *   `ntfy.minimalWorkspaces`, and it outranks everything. One repo you never want in a
 *   channel does not deserve a space of its own.
 * - **the space's own `slackChannel`** is the answer when it has one, in *both*
 *   directions: a channel id sends this space's questions there, and `null` or `""`
 *   means this space never posts however the global is set. A space that is quiet on the
 *   phone and noisy in a work channel is the failure this exists to make expressible,
 *   and it is only expressible if a space can say no.
 * - **`slack.channel`** is the global default for everything else.
 *
 * There is deliberately no answer at all until `slack.enabled` is true *and* a channel
 * has been named. Unconfigured has to mean that no code path runs — no token read, no
 * request made — rather than "posts nowhere", because those two look the same on a
 * working install and very different on a broken one.
 *
 * Note this says nothing about *when* a question may be posted. That is `isQuiet` and
 * the inbox filter, asked once by the caller for both surfaces at once — see
 * `quietReasonFor` and its one call site in lib/server.js.
 */
export function slackChannelFor(cfg, workspaceName) {
  if (!cfg?.slack?.enabled) return null;
  if ((cfg.slack.excludeWorkspaces || []).includes(workspaceName)) return null;
  const space = spaceFor(cfg, workspaceName);
  if (space && 'slackChannel' in space) return String(space.slackChannel || '').trim() || null;
  return String(cfg.slack.channel || '').trim() || null;
}

/**
 * How much of a question goes into the channel — `full` or `minimal`.
 *
 * Its own knob rather than a reuse of `ntfyDetailFor`, and the difference is the whole
 * argument. A space is `minimal` on ntfy because an ntfy.sh topic is readable by anyone
 * who guesses its name: that mode exists for a *public relay*, and a Slack channel you
 * named in your own config is not one. Rounding a work space to minimal here would put a
 * contentless nudge in the one channel where the question belongs in full.
 *
 * So it defaults to `full` at both levels, and a space that wants the other answer says
 * so with `slackDetail` — the right setting for a channel with people in it who should
 * see that a decision is waiting without seeing what it is about.
 */
export function slackDetailFor(cfg, workspaceName) {
  const space = spaceFor(cfg, workspaceName);
  if (space?.slackDetail) return space.slackDetail;
  return cfg?.slack?.detail || 'full';
}

/* ================================== the space is the unit, and stays it per repo

   The five answers below — `autoDispatch`, `autoEndorse`, `autoMerge`,
   `requireApproval`, `autoShip` — are per *space*, and a space is a set of workspaces.
   (Four of the five also take a per-*workspace* override — `PER_WORKSPACE` at the top of
   this file, which `autoEndorse` needed first and which `autoMerge`, `requireApproval`
   and `autoShip` have since joined. That is a different question from the one settled
   here, and it is settled the other way by this block's own second reason: a workspace
   *is* a tracker, so "who else reads this" is a fact about it, and one workspace in a
   space may therefore answer for itself. What those overrides still say nothing about is
   a checkout *inside* a workspace, which is what the four reasons below refuse —
   `autoShipPerWorkspace` can say that beadcause ships its own merges while the five other
   repos in its space go on waiting for a tap; nothing can say it of one of Climative's
   forty checkouts.)
   That was the same thing as "per repo" for as long as a workspace was one checkout.
   `lib/repos.js` ended that: `climative` is one beads workspace over forty-odd checkouts
   of a company's GitHub org, so one `autoMerge` now governs every repo in the org, and
   the comments below still argue their case in the words "on everywhere except the shared
   repo" — a setup which stops being expressible the moment the shared repo and the
   private one are the same workspace. Worth deciding rather than inheriting: bc-l853.7.

   **The decision is that the space stays the unit, and Climative gets one answer.** Four
   reasons, in the order they settle it.

   **What varies between repos is not what these ask.** Every one of them asks whether an
   unattended agent may act without you having looked — reply, work a filing, merge, ship.
   What makes that answer differ between two checkouts is whether anybody else reads the
   repo, and inside an org it does not differ: all forty are repos with colleagues on them.
   `architecture` is not the shared one among private siblings, it is the *most* shared,
   because it also holds the workspace's Dolt remote. The setup these fields were written
   for has no instance here, and the config Adam actually wrote agrees — the Climative
   space says `autoMerge: false` and `autoShip: false` once, for all of them.

   **The trust boundary is the tracker, and there is one of it.** `autoDispatchExclude`
   is per workspace because a workspace is a graph, and a graph other people read must
   never be auto-answered whatever space it lands in. Climative's repos share one `cl-`
   graph: a bead in it is visible, editable and answerable by everyone in the org whichever
   checkout it is about. So "who else sees this, and would they mind an agent acting on it
   unasked" is a fact about the workspace rather than about the checkout, and a per-repo
   answer would be a finer grain than the thing it is describing.

   **An override could only ever loosen, and there is nowhere safe for it to point.** A
   space set conservatively for a shared org plus an exception for one repo is a mechanism
   whose only use is to let one checkout out of the answer the shared tracker earned — and
   that repo's beads are still in the shared graph, so an agent working one unasked is
   still acting on work a colleague filed. A conservative-only veto beside
   `autoDispatchExclude` buys nothing either: the space is *already* at the conservative
   answer, so vetoing it again changes nothing. Neither direction is both useful and safe.
   A Climative repo that genuinely wants a looser answer than the shared tracker's is a
   repo whose work does not belong in the shared graph — take it out of
   `repos.climative.approved` and give it its own workspace, which is what every
   non-Climative repo already is.

   **And it could not be set from where these get set.** Everything from `SETTINGS` down
   exists because a policy you can only change by editing `config.json` at a keyboard
   stays wrong until you are next at one. A per-repo answer would live in the `repos`
   block, which is a config-file act — exactly the failure the space details screen ended
   — and making it phone-settable means forty rows of five toggles on a 393px screen,
   which is not a screen. It is not a field either: every resolver here takes a workspace
   *name*, and which repo a bead is about is a fact about the bead (bc-l853.2), so this
   would be a new argument threaded through eight call sites rather than a key.

   **What the decision does oblige** is that the screen stop implying one repo per row.
   One row labelled `climative`, in a panel titled "what each repo resolves to", stood for
   forty-odd checkouts and counted as one — understating the reach of every setting above
   it on the one screen where you decide whether a worker merges its own diff. So a row
   says how many checkouts its single answer governs: see `spaceDetail` at the bottom. */

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
 * **And a single workspace outranks the space** — see `PER_WORKSPACE` below, which this
 * was the first setting to need and is no longer the only one.
 *
 * What this does *not* change: the priority clamp, the `agent-filed` label and the
 * `discovered-from` edge all still go on (lib/filing.js), so an auto-endorsed bead is
 * still capped at P2, still findable by one `bd list --label agent-filed`, and still
 * carries the bead it was discovered under. Auto-endorsement drops the hold, not the
 * provenance — the audit is the whole of what is left, and it has to survive.
 */
export function autoEndorseAllowed(cfg, workspaceName) {
  return workspaceAnswer(cfg, workspaceName, 'autoEndorse');
}

/**
 * What `autoEndorseAllowed` would answer for this workspace with its own override taken
 * away — which is what an Inherit button on the repo row has to be able to name.
 */
export function autoEndorseInherited(cfg, workspaceName) {
  return workspaceInherits(cfg, workspaceName, 'autoEndorse');
}

/* ============================================================== per-repo overrides

   Four answers a *workspace* may give for itself, outranking the space it sits in.

   `autoEndorse` was the first, and the block above `autoDispatchAllowed` argues the
   general case from it: the reason to stop holding filings — nobody but me reads this
   tracker, so the tap is not a review — is true of one checkout and not of the five
   sitting beside it in the same space. The Personal space here is beadcause, deluvia,
   ehatt, sophab and two more, and answering for one of them meant answering for six.

   The other three are the same shape and the same argument, applied to the sentence
   that matters more: **does finished work land and go live without a tap.** `autoMerge`
   is whether a worker merges its own pull request, `requireApproval` is whether an
   approving review is needed first, and `autoShip` is whether the merge then deploys
   itself. beadcause is the repo where all three want to be yes — it is the one whose
   deploy this Mac can actually run, whose gate runs on every pull request, and whose
   tracker nobody else reads — and it shares a space with five repos where they want to
   be no. A space could not say that, so the only way to ship beadcause unattended was
   to arm five other repos at the same time.

   What this deliberately does **not** loosen is the gate. `autoMerge` decides who
   presses merge, never what merge means: `bin/deliver.js` still waits for the checks
   (`settle` in lib/pr.js), still refuses on a red one or one that never reported, and
   still falls back to the question with the reason on it. `autoShip` only ever reaches a
   merge that is already on `origin/main` (lib/release.js). A repo turned on here ships
   *because* it passed the gates, not instead of passing them.

   ## One map per setting, keyed by workspace name

   `autoEndorsePerWorkspace: { "beadcause": true }` was here first and keeps its name and
   its shape; the three new ones are maps of their own beside it. Keyed by name like
   `jira` and `advocates.perWorkspace`, and for their reason — the `workspaces` array is
   rediscovered on every start, so a field written onto an entry there is gone by the
   next restart.

   Not one map of objects (`perWorkspace: { beadcause: { autoShip: true } }`), which
   would have been tidier on paper: the existing key is already in config files on disk
   and in `saveConfig`'s defaults, and a migration that has to move live policy from one
   shape to another risks reading "not set" for a beat — which for two of these four
   fields is the *permissive* answer. Four flat maps cost one table here and nothing
   anywhere else.

   ## Absent means inherit, and only a real boolean overrides

   `null`/absent is "follow the space", which is a different answer from `false` and has
   to survive the space changing under it. Anything that is not a real boolean — a
   hand-edited `"true"` — is ignored rather than coerced, exactly as the space level
   does: an unreadable override asked for nothing legible, and inheriting is the honest
   reading of one.
*/

/** Each per-repo setting and the config key its map lives in. */
export const PER_WORKSPACE = {
  autoEndorse: 'autoEndorsePerWorkspace',
  autoMerge: 'autoMergePerWorkspace',
  requireApproval: 'requireApprovalPerWorkspace',
  autoShip: 'autoShipPerWorkspace',
};

/**
 * What each setting falls back to when neither the workspace nor its space says
 * anything. `autoMerge` is on unless switched off; the other three are off unless asked
 * for, for the reasons their own docblocks give.
 */
const GLOBAL_DEFAULT = {
  autoEndorse: (cfg) => cfg?.autoEndorse === true,
  autoMerge: (cfg) => cfg?.pr?.autoMerge !== false,
  requireApproval: (cfg) => cfg?.pr?.requireApproval === true,
  autoShip: (cfg) => cfg?.release?.autoShip === true,
};

/** The settings a repo row on the space details screen may set. Anything else is refused. */
export const WORKSPACE_SETTINGS = Object.keys(PER_WORKSPACE);

/** This workspace's own answer to one field — a real boolean, or `null` for "inherit". */
function ownSetting(cfg, workspaceName, field) {
  const raw = cfg?.[PER_WORKSPACE[field]]?.[workspaceName];
  return typeof raw === 'boolean' ? raw : null;
}

/**
 * What one field resolves to for this workspace with its own override taken away — the
 * space, then the global.
 *
 * This is what an Inherit button has to be able to name, and it is a function rather
 * than `workspaceAnswer` over a doctored config for the reason the old
 * `autoEndorseInherited` gave: the row is drawn from the live `cfg` the running daemon
 * reads on every push, and cloning the whole config per repo per repaint to ask a
 * hypothetical would put a copy of it in the render path.
 */
export function workspaceInherits(cfg, workspaceName, field) {
  const space = spaceFor(cfg, workspaceName);
  // `typeof` rather than `??`: only a real boolean is an override. See the block above.
  if (typeof space?.[field] === 'boolean') return space[field];
  return GLOBAL_DEFAULT[field](cfg);
}

/**
 * The answer the daemon actually gives for one field in one workspace: its own override,
 * then its space, then the global. The one resolution path — every caller and every
 * screen goes through here, so what a repo row draws and what `bin/deliver.js` does are
 * the same answer by construction.
 */
export function workspaceAnswer(cfg, workspaceName, field) {
  const own = ownSetting(cfg, workspaceName, field);
  return own === null ? workspaceInherits(cfg, workspaceName, field) : own;
}

/**
 * What this workspace itself says, field by field, with `null` for every one it leaves to
 * the space and the global. The per-repo twin of `readSettings`.
 */
export function readWorkspaceSettings(cfg, workspaceName) {
  return Object.fromEntries(WORKSPACE_SETTINGS.map((key) => [key, ownSetting(cfg, workspaceName, key)]));
}

/** What every one of them would resolve to with this workspace's own answers taken away. */
export function workspaceInherited(cfg, workspaceName) {
  return Object.fromEntries(WORKSPACE_SETTINGS.map((key) => [key, workspaceInherits(cfg, workspaceName, key)]));
}

/**
 * Apply a patch to one workspace's own overrides, in place on `cfg`. Returns the fields
 * that actually changed, exactly like `applySettings`, and throws on anything it does
 * not understand for the same reason: a setting silently dropped is the failure the
 * screen exists to end.
 *
 * `null` deletes the key, and deleting is the only way back to inheriting — "off" and
 * "following a space that is off" are different answers that have to survive the space
 * changing under them, which is the same argument the space rows make for their own
 * Inherit button.
 *
 * Each map is created on demand and left in place once empty, rather than deleted: they
 * are config defaults (see lib/config.js), so an absent one and an empty one already
 * mean the same thing to every reader here.
 *
 * Nothing here writes to disk — `applySettings` says why, and it is the same `cfg` object
 * the running daemon reads.
 */
export function applyWorkspaceSettings(cfg, workspaceName, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');

  const unknown = Object.keys(patch).filter((k) => !WORKSPACE_SETTINGS.includes(k));
  if (unknown.length) throw new Error(`not a per-repo setting: ${unknown.join(', ')}`);

  const before = readWorkspaceSettings(cfg, workspaceName);

  for (const [key, raw] of Object.entries(patch)) {
    const where = PER_WORKSPACE[key];
    const map =
      cfg[where] && typeof cfg[where] === 'object' && !Array.isArray(cfg[where]) ? cfg[where] : (cfg[where] = {});
    if (raw === null) {
      delete map[workspaceName];
      continue;
    }
    if (typeof raw !== 'boolean') throw new Error(`${key} must be true, false or null`);
    map[workspaceName] = raw;
  }

  const after = readWorkspaceSettings(cfg, workspaceName);
  return WORKSPACE_SETTINGS.filter((key) => before[key] !== after[key]);
}

/**
 * Does a worker in this workspace merge its own pull request, and must someone have
 * approved it first?
 *
 * Both halves used to be one global answer — `cfg.pr.autoMerge`, on by default, the
 * same for every repo in every space. That is wrong at the edges in both directions,
 * and the wrongness is per space *and* per workspace: a personal side project wants its
 * work landed without being asked at three in the morning, anything with other people on
 * it wants eyes on the diff before it is in `main`, and the two live side by side in one
 * space here. So a space answers, and a single workspace inside it may answer for itself
 * — `PER_WORKSPACE` above, which is where the third level came from and why.
 *
 * Three things are worth being explicit about.
 *
 * **The global is a default here, not a veto** — which is the one way this differs
 * from `autoDispatchAllowed` above. There, `autoDispatch: false` is a safety switch
 * ("no unattended agent answers anything, anywhere") and a space must not be able to
 * talk its way out of it. Here both answers are ordinary policy, and only a default
 * a space can override in *either* direction can express the two setups that
 * motivated this: on everywhere except the shared repo, and off everywhere except
 * the side project. So an explicit boolean wins at whichever level states one, and a
 * level that says nothing inherits.
 *
 * **Neither half decides what a merge *means*.** `autoMerge` says who presses the
 * button, and `bin/deliver.js` gates that press on the same things it always did — it
 * waits for the pull request's checks (`settle` in lib/pr.js), refuses over a red one or
 * one that never reported, and falls back to the question with the reason on it. A repo
 * turned on here merges *because* it passed the gate.
 *
 * **Resolved together, and read together.** `bin/deliver.js` decides whether to
 * merge and `lib/session.js` writes the brief promising what that command will do;
 * a brief promising a merge to a session whose delivery then files a question is how
 * you get a window reporting work as landed over a bead that says otherwise. One
 * helper returning both means the two cannot drift apart on either.
 *
 * There is deliberately no per-workspace *exclude list* beside these, unlike
 * `autoDispatchExclude`: that one exists because a shared tracker must never be
 * auto-answered whatever space it lands in, and no equivalent safety property holds
 * here. A workspace that wants a different answer says so in either direction, which a
 * list cannot do.
 */
export function prPolicyFor(cfg, workspaceName) {
  return {
    autoMerge: workspaceAnswer(cfg, workspaceName, 'autoMerge'),
    // Only meaningful while `autoMerge` is on: with it off every delivery is already a
    // question, and an approval is what answering it *is*.
    requireApproval: workspaceAnswer(cfg, workspaceName, 'requireApproval'),
  };
}

/**
 * Does a merge in this workspace deploy itself, without waiting for a tap?
 *
 * The third policy answer, and the one with teeth. A ship bead says "merged, not live"
 * and then waits for **Ship** on the pull request board, so merged work sits on
 * `origin/main` for as long as it takes to be noticed. With this on, the release queue
 * runs the repo's own declared deploy instead — see lib/release.js for the settle window
 * that makes four merges one deploy, and lib/autoship.js for the epic that may override
 * this in either direction.
 *
 * **The global default is off, and it is a default rather than a veto.** Off is what
 * every install does today, and an upgrade must not start restarting daemons on its own.
 * But a space saying `true` beats it, exactly as `autoMerge` does — and a workspace
 * saying `true` beats the space, which is the level this setting most needed. Only one of
 * the six repos in the Personal space here has a deploy this Mac can run at all, and
 * arming the other five to say so about one of them was the whole cost of the space being
 * the finest grain available.
 *
 * **What this never skips is the gate**, and the reason is structural rather than a check
 * written here: the release queue only ever sees a merge that is already on `origin/main`
 * (lib/release.js), and the only ways to get there are a worker's own merge — gated on
 * green checks by `bin/deliver.js` — or a thumb. Auto-ship deploys work that already
 * passed; it cannot deploy work that has not landed.
 *
 * Note what `false` does *not* buy, because it is a property of deploying rather than a
 * gap here: a deploy makes everything on `origin/main` live at once, so a merge in a
 * workspace set to `false` still goes live the moment something else fires a deploy of
 * that checkout. What `false` guarantees is that nothing here is ever the *reason* a
 * deploy ran — which is the same guarantee the Ship button gives today.
 */
export function autoShipAllowed(cfg, workspaceName) {
  return workspaceAnswer(cfg, workspaceName, 'autoShip');
}

/**
 * What the phone needs to draw the space row: every configured space, plus a
 * synthetic one for workspaces nobody assigned. The stray group only appears when
 * it has something in it, so a fully-assigned setup shows a clean row.
 *
 * `troubled` is the workspaces whose sweep threw (see lib/sweep.js). A count is
 * arithmetic over the rows that came back, so a repo that did not answer is one the
 * total is silently missing — and the row says `unknown: true` rather than letting
 * the number read as a fact. Not a smaller number and not a hidden row: the count is
 * still the best answer available, it just stops being a confident one.
 */
export function summarise(cfg, questions, troubled = []) {
  const spaces = cfg.spaces || [];
  if (!spaces.length) return [];

  const assigned = new Set(spaces.flatMap((s) => s.workspaces || []));
  const unsure = new Set(troubled);
  const now = new Date();

  const rows = spaces.map((s) => ({
    name: s.name,
    workspaces: s.workspaces || [],
    quiet: isQuiet(s, now),
    muted: Boolean(s.muted),
    count: questions.filter((q) => (s.workspaces || []).includes(q.workspace)).length,
    // Only ever `true`. Absent is what every payload has always said and what a
    // client that has never heard of it goes on reading — see the picker.
    ...((s.workspaces || []).some((w) => unsure.has(w)) ? { unknown: true } : {}),
  }));

  // A repo in no configured space that failed its sweep still has to be visible, and
  // holding no rows it would otherwise not be here at all: the stray group is built
  // from the questions that arrived, and it arrived with none.
  const strayNames = [
    ...new Set([
      ...questions.filter((q) => !assigned.has(q.workspace)).map((q) => q.workspace),
      ...[...unsure].filter((w) => !assigned.has(w)),
    ]),
  ];
  if (strayNames.length) {
    rows.push({
      name: 'Other',
      workspaces: strayNames,
      quiet: false,
      muted: false,
      count: questions.filter((q) => !assigned.has(q.workspace)).length,
      ...(strayNames.some((w) => unsure.has(w)) ? { unknown: true } : {}),
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
 * Why this bead is not allowed to make a noise — `'addressed'`, `'filtered'`,
 * `'muted'`, or null when it may.
 *
 * The single place any of those answers is decided, so the question push, the foundation
 * request push and the reply push cannot drift apart on it. All three mean the same
 * thing to everything downstream: the event is still emitted, the card still files, the
 * badge still counts — the phone just stays dark. Filtering must never lose a bead, only
 * quieten it, which is the contract a muted space already has and the contract an
 * addressee joins rather than extends.
 *
 * **`'addressed'` is tested before either of the others, and it is the only one of the
 * three that names somebody else's decision rather than a setting of yours** (bc-cvwk).
 * A filter is a thing you set a minute ago and can widen; a mute ends on a clock. A bead
 * addressed to another engineer will not ring on this Mac however far you widen the
 * filter and however long you wait, so reporting it as `'filtered'` would be a true
 * sentence pointing at the wrong lever — it would send somebody to press **All** for a
 * card that was never hidden from them in the first place. See lib/addressee.js.
 *
 * **And unlike the filter, it reaches the foundation channel.** The exemption below is
 * argued from what the filter's two levels *are* — space and workspace, both answers to
 * "which of my lives is this about", a question a constitutional request has no answer
 * to. An addressee is the other question, "whose decision is this", and an agent asking
 * to change what it is has a perfectly good answer to that one: the person whose agent
 * it is. Six engineers each running their own agents is exactly the case where a request
 * belongs to one of them.
 *
 * The filter is tested next, and the order between it and the mute is the reason rather
 * than a tie-break:
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
  if (addressedElsewhere(cfg, q)) return 'addressed';
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

   `slackChannel` is the one field with a *third* value, and it is not an exception to
   that rule so much as the reason for it: a channel id, `null` for "follow
   `slack.channel`", and `""` for "this space never posts, whatever the global says".
   The two ways of saying nothing are different answers, and `slackChannelFor` tells
   them apart by whether the key is there at all.

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
  'slackChannel',
  'slackDetail',
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
    // The one field where `null` and `""` are both real answers and mean different
    // things: no key at all follows `slack.channel`, and a key set to nothing is this
    // space saying it never posts however the global is set. `slackChannelFor` reads
    // the *presence* of the key for exactly that reason, so collapsing the two here
    // would leave the screen unable to draw the answer the resolver exists for.
    slackChannel: space && 'slackChannel' in space ? String(space.slackChannel ?? '').trim() : null,
    slackDetail: DETAILS.includes(space?.slackDetail) ? space.slackDetail : null,
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
    } else if (key === 'ntfyDetail' || key === 'slackDetail') {
      // One branch for both because they are one shape — `full` or `minimal`, or the
      // key gone. What differs is only what they default *to*, which is `slackDetailFor`'s
      // argument and not this function's.
      if (clear) {
        delete space[key];
        continue;
      }
      if (!DETAILS.includes(raw)) throw new Error(`${key} must be ${DETAILS.join(' or ')}`);
      space[key] = raw;
    } else if (key === 'slackChannel') {
      if (clear) {
        delete space.slackChannel;
        continue;
      }
      if (typeof raw !== 'string')
        throw new Error('slackChannel must be a channel id, "" for never, or null to follow the global');
      // `""` is *stored*, not deleted, and that is the whole difference between the two
      // ways of saying no here. Deleting it would put the space back to following
      // `slack.channel` — which is the opposite of what somebody pressing Never meant.
      space.slackChannel = raw.trim();
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
 *   not the last word on three of these: `ntfy.minimalWorkspaces`,
 *   `slack.excludeWorkspaces` and `autoDispatchExclude` are per-repo lists that outrank
 *   it, so a space set to `full` can contain a repo that pushes minimally. A screen
 *   that showed only the space's own answer would be quietly wrong about that repo, and
 *   it would be wrong in the direction of promising you more detail on your phone than
 *   you will get.
 *
 *   The four in `WORKSPACE_SETTINGS` are also *settable* from here — see `PER_WORKSPACE`
 *   at the top of this file — so every row carries `own` (what this repo itself says,
 *   `null` per field for nothing) and `inherits` (what Inherit would resolve to) beside
 *   the resolved answers. That is the same trio the space rows are drawn from, one level
 *   down.
 *
 * A row is a *workspace*, and since lib/repos.js that is no longer the same thing as a
 * repo — so a row carries `checkouts` when its workspace holds an approved list, and the
 * panel that used to count one repo per row counts those instead. That is also what makes
 * the settable half above sound: it writes a workspace's answer, which is the grain the
 * overrides are keyed at. The space is deliberately still the unit these answers are
 * *given* at, and the four exceptions are only ever between workspaces rather than inside
 * one (see the block above `autoDispatchAllowed`); what a screen may not do is let one row
 * labelled `climative` read as one checkout when the answer beside it governs forty.
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
      // Not a space setting and not editable here — it is `slack.enabled`, and the card
      // needs it because a channel set on a space while Slack is globally off is a
      // control that changes nothing. Better said on the row than discovered by
      // wondering why the channel never got a message.
      slack: Boolean(cfg?.slack?.enabled),
    },
    repos: inside.map((w) => ({
      name: w,
      // Only for a workspace with an approved list, so every payload that has ever been
      // sent says exactly what it said before — the same reasoning as `unknown` in
      // `summarise`. The count is the checkouts that *resolved*: one whose token is
      // missing or unreadable can hold no bead at all, so counting it would inflate the
      // reach of the answer beside it. `0` is a real state — an approved list where
      // nothing resolved — and says more than an absent field would.
      ...(multiRepo(cfg, w) ? { checkouts: repoList(cfg, w).repos.length } : {}),
      ntfyDetail: ntfyDetailFor(cfg, w),
      autoDispatch: autoDispatchAllowed(cfg, w),
      autoEndorse: autoEndorseAllowed(cfg, w),
      // The four a row can *set* need the other two claims a three-state control is made
      // of, beside the resolved answers around them: what this repo itself says (`null`
      // for nothing, which is what puts Inherit on), and what Inherit would resolve to
      // today. Grouped rather than eight flat `<field>Own`/`<field>Inherited` keys,
      // because the control at the other end is a loop over `WORKSPACE_SETTINGS` — a
      // shape that loop can index is what stops a fifth setting needing a line here, a
      // line in the payload and a line in the client before it draws.
      own: readWorkspaceSettings(cfg, w),
      inherits: workspaceInherited(cfg, w),
      autoShip: autoShipAllowed(cfg, w),
      // The resolved answer, not the space's own field, on the same reasoning as
      // `ntfyDetail` above: `slack.excludeWorkspaces` outranks the space, so a space
      // with a channel can contain a repo that posts to none. `null` is the ordinary
      // reading — Slack is off, or this repo is not in it.
      slackChannel: slackChannelFor(cfg, w),
      slackDetail: slackDetailFor(cfg, w),
      ...prPolicyFor(cfg, w),
    })),
    defaults: {
      ntfyDetail: cfg?.ntfy?.detail || 'full',
      // `null` rather than `''`: what Inherit resolves to when nothing is configured is
      // "nowhere", and the card says that word. The space's own `''` is a different
      // answer with the same effect, which is why the two are not one value.
      slackChannel: String(cfg?.slack?.channel || '').trim() || null,
      // Full at both levels, unlike ntfy — a channel you named in your own config is
      // not a public relay. See `slackDetailFor`.
      slackDetail: cfg?.slack?.detail || 'full',
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
