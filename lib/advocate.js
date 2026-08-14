/**
 * One advocate per repo.
 *
 * Everything else in beadcause is a *channel*: a question reaches your phone, an
 * answer reaches the bead, a comment reaches an agent. Nothing in it ever cared
 * whether the work got done. So a workspace could sit on nine ready beads for a
 * fortnight and the daemon that knew about all nine would say nothing, because
 * none of them was labelled `human` and nobody had asked.
 *
 * An advocate is the missing party: something whose only interest is *this repo's*
 * queue reaching zero. It surveys the actionable set every poll, opens a Claude
 * session on what is ready, and stops when there is nothing left. It is not a
 * scheduler — it holds no clock of its own — because the daemon is already polling
 * every 30 seconds and a bead that becomes ready is exactly the event worth waking
 * for.
 *
 * Three rules give it its shape:
 *
 * 1. **It works what exists; it may not invent work.** Opening a session on a bead
 *    you filed needs no permission — you filed it. Filing a bead *for* you is a
 *    different act: it makes you answerable for something an agent thought of. So
 *    proposing goes through the inbox as an ordinary question carrying the full
 *    text of every bead it wants, and nothing is created until you press create.
 *    See lib/proposal.js.
 *
 * 2. **It never claims to know more than it does.** It knows it launched a window
 *    for a bead; it does not know that a given `claude` process is that window.
 *    Where the session was told to name itself after the bead the two are matched
 *    on that name and nothing else — the same discipline lib/claude.js keeps.
 *
 * 3. **Every cap is loud.** A slot limit that silently drops a launch reads exactly
 *    like an advocate that has decided there is nothing to do. So a launch refused
 *    for want of a slot says so, in the log and on the card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import { CONFIG_DIR, OBSERVING, OBSERVING_NOTE, saveConfig } from './config.js';
import { writeJsonAtomic } from './atomic.js';
import { snapshot } from './commonrepo.js';
import { QUEUE_EXCLUDED } from './endorse.js';
import { hasP0Above, NO_P0_ABOVE } from './underp0.js';
import { homeIn } from './homing.js';
import { checkinMessage, messageSession, openPlanSession, openWorkSession, resolveSessionDir } from './session.js';
import { dispatchable, PLANNED_LABEL, PROMOTED_LABEL, readPlan, unplanned } from './plan.js';
import { filePromotion } from './promote.js';
import { beadToken, multiRepo, repoKey, repoList, resolveRepo } from './repos.js';
import { liveSessions } from './claude.js';
import { isWorkspaceQuiet, spaceFor, quietUntil } from './spaces.js';
import { setActivity, clearActivity } from './activity.js';
import * as agentlog from './agentlog.js';
import { parseProposal, proposalBody, proposalTitle, dupeNote } from './proposal.js';
import { annotateDuplicates, findDuplicate, liveCandidates } from './dupe.js';
import { sweepWorktrees, describeSweep, expireRetired, describeExpiry, slimAttic, describeSlim } from './tidy.js';
import { reconcileLanded, describeLanded, describeTruncation } from './landed.js';
import { openWork, inflightWhy, describeInflight } from './inflight.js';
import * as claims from './claims.js';
import { busyWhy, occupiedBy, surfaceOf } from './beadfiles.js';
import { sweepSuperseded, describeSuperseded } from './superseded.js';
import { sweepInMain, describeInMain } from './inmain.js';
import { sweepNotInMain, describeNotInMain } from './notinmain.js';
import { archiveSession, mergeCommitFor, noteMerge, mainCheckout } from './sessionlog.js';
import { effective, claudeArgs, promptArgs, agentEnv } from './foundation.js';
import { memoryBrief } from './memory.js';
import * as agentrepo from './agentrepo.js';
import { lookupBrief } from './lookup.js';
// Empty on every install that has not named a readable space — see lib/confluence.js.
import { confluenceBrief } from './confluence.js';
import { ownerName } from './owner.js';
import * as amendment from './amendment.js';
import { cardsForDelivery, DELIVERY_LABEL } from './delivery.js';
import { closingFor, decide, namesBead, signal, sweepCandidate, sweepingFor, REAP_DEFAULTS } from './reap.js';
import {
  describeLease,
  handleFor,
  leaseLabel,
  leaseVerdict,
  renewDue,
  standDownWhy,
  LEASE_DEFAULTS,
} from './lease.js';

const STATE_PATH = path.join(CONFIG_DIR, 'advocates.json');

/**
 * Where a work session records that it exited.
 *
 * The window belongs to iTerm and the process to the shell inside it, so the daemon
 * has nothing to listen to — but the session can tell us itself: its command ends
 * by writing `$?` here and exiting, which both closes the window and turns "has it
 * finished?" from an inference into a fact. See `launch` in lib/session.js.
 *
 * The inference is kept anyway, as a fallback: closing the window by hand kills the
 * shell with a SIGHUP before it can write anything, and that case has to resolve too.
 */
const WORKER_DIR = path.join(CONFIG_DIR, 'workers');
const doneFileFor = (workspace, id) => path.join(WORKER_DIR, `${`${workspace}-${id}`.replace(/[^A-Za-z0-9._-]/g, '_')}.done`);

/** The exit status a finished session left behind, or null while it is still going. */
function readDone(workspace, id) {
  try {
    const code = Number(fs.readFileSync(doneFileFor(workspace, id), 'utf8').trim());
    return { code: Number.isFinite(code) ? code : null };
  } catch {
    return null;
  }
}

function clearDone(workspace, id) {
  try {
    fs.rmSync(doneFileFor(workspace, id), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/**
 * Where a session says "yes, I am still working on it".
 *
 * The other half of the same idea as the done file, and a file for the same reason:
 * the answer comes from a process the daemon does not own, five minutes after the
 * question, possibly across a restart. `bin/checkin.js` writes it, `readCheckin`
 * reads it, and nothing in between has to be running.
 *
 * Exported because the bin needs the identical path — a check-in written a directory
 * away from where it is read is the worst possible failure here: the session answered,
 * and its slot is taken anyway.
 */
export const checkinFileFor = (workspace, id) =>
  path.join(WORKER_DIR, `${`${workspace}-${id}`.replace(/[^A-Za-z0-9._-]/g, '_')}.checkin`);

/** The last thing a session said about itself, or null if it has said nothing. */
function readCheckin(workspace, id) {
  try {
    const said = JSON.parse(fs.readFileSync(checkinFileFor(workspace, id), 'utf8'));
    return said?.at ? { at: String(said.at), note: String(said.note || '') } : null;
  } catch {
    return null;
  }
}

function clearCheckin(workspace, id) {
  try {
    fs.rmSync(checkinFileFor(workspace, id), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** The label that marks a question as an advocate asking to create beads. */
export const PROPOSAL_LABEL = 'advocate-proposal';

/**
 * Hard ceiling on the configurable ceiling. Three windows is already a lot of Mac.
 *
 * Exported because it is also the range of the stepper on the advocate card, and the
 * card and the server have to agree about it: a button that offers a number the
 * server will clamp away is a button that lies about what it did.
 */
export const MAX_WORKERS_CEILING = 9;

/**
 * And the hard ceiling on the *total*, which bounds a different thing: the per-repo
 * one bounds how many windows may argue about a single codebase, and this bounds the
 * Mac they all run on.
 *
 * Four repos at their own ceiling. Exported for the same reason as the number above —
 * the global stepper on the console offers exactly this range, and a button that
 * offers a number the daemon will clamp away is a button that lies about what it did.
 */
export const GLOBAL_WORKERS_CEILING = MAX_WORKERS_CEILING * 4;

const DEFAULTS = {
  enabled: true,
  workspaces: [],
  maxWorkers: 1,
  maxWorkersLimit: 3,
  // Twenty rather than ten. Ten was picked when this cap was the only thing standing
  // between an unattended daemon and a Mac full of windows nobody had asked for; with
  // check-ins, reaping and the reclaim button all landed since, the number that
  // actually binds on an ordinary day should not be the one you cannot change without
  // an editor. `moveGlobalWorkersDefault` in lib/config.js is the half of this that
  // reaches a machine which already stored the old ten.
  globalMaxWorkers: 20,
  perWorkspace: {},
  minPriority: 3,
  settleSeconds: 60,
  launchCooldownSeconds: 120,
  lapseMinutes: 10,
  workerTimeoutMinutes: 120,
  checkinMinutes: 10,
  maxAttemptsPerBead: 2,
  // Hand an epic's ready children to one worker as a batch, instead of holding the epic
  // back and letting each child take its own window on its own tick. See `batchesFor`.
  // Off switches the whole thing back to `heldByChildren`'s suppression, which is what
  // this did before and is still the safe answer if a batch ever briefs badly.
  batchEpicChildren: true,
  // How many of an epic's ready children one worker is briefed on. Five rather than
  // unbounded: an epic with twenty children would otherwise produce a brief no session
  // can hold, and the whole point of batching is a worker that understands what it was
  // given. The children that do not fit are not launched separately either — see
  // `batchesFor` on why the overflow waits rather than racing its own siblings.
  maxBatchBeads: 5,
  // And the floor, which is what keeps this feature to the problem it was filed for. With
  // one ready child there is no round-robin to fix: the old suppression already spends one
  // window on that child, briefed on exactly the bead it is doing. Batching it instead
  // claims the epic, hands over a brief about choosing phases when there are none to
  // choose, and leaves an epic that has to be handed back — all to do the same single
  // bead. Two is where siblings start being split across windows that cannot see each
  // other, so two is where this starts. Set to 1 to batch a lone child as well.
  minBatchBeads: 2,
  // Open an epic worker on an epic that has no plan, rather than a batch head on it — a
  // window that plans the epic into groups for N child-workers and does none of the work
  // itself. See lib/plan.js, and see `batchesFor`, which is the same candidate test: an
  // epic that would have been batched is exactly an epic that gets planned instead, so
  // the two can never disagree about which subtree they are in. Off falls all the way
  // back to bc-bhp9's mechanical batching, which is what this did before plans existed
  // and is still the right answer if a plan ever briefs badly.
  planEpics: true,
  // File a promotion bead when every bead a plan named has closed — the unit a release
  // agent carries through UAT and production, and deliberately not the per-merge `ship`
  // bead lib/release.js files. See lib/promote.js for why two things called a release
  // bead, settling on different evidence, is a board that lies.
  filePromotions: true,
  respectQuietHours: true,
  propose: true,
  proposeCooldownHours: 12,
  maxProposals: 5,
  proposeTimeoutMs: 600000,
  tidyWorktrees: true,
  tidyIntervalMinutes: 15,
  // How long a retired worktree stays in `.claude/worktrees-retired/` before the
  // same sweep removes it for good. 0 keeps the attic forever, which is what
  // beadcause did before this existed and is still a legitimate thing to want.
  tidyAtticDays: 2,
  // Close beads whose pull request merged on github.com rather than from a card — see
  // lib/landed.js. On by default, because the failure it fixes is one this cannot see:
  // a bead nothing closed looks exactly like a bead nobody has done yet, and the
  // advocate answers that by opening a session on it.
  reconcileLanded: true,
  // One `gh pr list` per repo, this far apart. The tick is every 30 seconds and the
  // answer changes when somebody merges something, so a sweep per tick would be six
  // repos' worth of traffic for a number that moves a few times a day. The cost of
  // being late is one session opened on landed work — which is what this is for — so
  // it is also asked *unconditionally before a launch*, whatever the interval says.
  landedIntervalMinutes: 10,
  // Ask about beads a worker marked `superseded-by:` another, once that other one closes
  // — see lib/superseded.js. On by default for the same reason as the sweep above: the
  // failure it fixes is a session opened on work that is already somebody else's, and
  // the alternative to asking is a bead held out of every queue with nothing to let it
  // out again.
  askSuperseded: true,
  // One `bd ready --json` per repo, this far apart. The event it is watching for — the
  // original closing — happens a few times a day at most, and unlike `readyHeld` there
  // is no label to narrow the query with, so a sweep per 30-second tick would be a busy
  // workspace's whole issue list every half minute for an answer that rarely moves.
  supersededIntervalMinutes: 10,
  // Ask about open beads naming a worktree branch that is already an ancestor of main —
  // see lib/inmain.js. The third member of the family above and the weakest evidence of
  // the three, which is exactly why it asks rather than closes: a merged branch is a
  // fact, "so the bead is done" is a judgement.
  flagInMain: true,
  // One `bd list --json` per repo plus a short git walk per branch named, this far
  // apart. The answer moves when somebody merges something, and the cost of being late
  // is one session opened on landed work — the same trade the two sweeps above make,
  // and the same ten minutes.
  inMainIntervalMinutes: 10,
  // And the same question upside down: a *closed* bead whose own branch never reached
  // main — see lib/notinmain.js. The one sweep in the family where the cost of missing
  // one is the work itself rather than a wasted window, which is why it is on by default
  // and why the only thing it may do is file a card.
  flagNotInMain: true,
  // One `bd list --status=closed --json` per repo — half a megabyte on a busy tracker,
  // where every other sweep here reads only live beads — plus a `gh pr list` for each
  // branch git says never landed. An hour rather than ten minutes because nothing about
  // the answer is urgent: a bead closed over an unlanded branch has been that way for
  // hours already, and it will still be true after lunch.
  notInMainIntervalMinutes: 60,
  // Hold a bead out of the queue while an open pull request already carries its work —
  // see lib/inflight.js. On by default, because the failure it fixes is the one the two
  // sweeps above cannot see: not work that already *landed*, but work that is sitting on
  // a branch waiting for a merge or a conflict resolution, whose bead reads as ready and
  // whose second session is briefed to merge a pull request somebody is still reviewing.
  holdOpenPrs: true,
  // One `gh pr list --state open` per repo, this far apart. Shorter than the sweeps above
  // because it is the only one of the four whose answer moves the moment *this daemon*
  // does something — a delivery opening a pull request is the event, and the bead it was
  // for goes back into `bd ready` in the same minute. Asked *unconditionally before a
  // launch* too, whatever the interval says, for the same reason `landedIntervalMinutes`
  // is: being late here costs a whole session, and one `gh` call does not.
  inflightIntervalMinutes: 5,
  // Hold a bead out of the queue while a live Claude Code session already names it —
  // see `withoutLiveSessions`. On by default, because the failure it fixes is the worst
  // of the family: not a wasted window, but two of them editing the same uncommitted
  // worktree at the same time (bc-vq78). No interval, because the records are files on
  // this laptop and the read is free.
  holdLiveSessions: true,
  // Hold a bead out of the queue while another session is already editing the files it
  // would touch — see lib/beadfiles.js and `withoutClaimedFiles`. The sixth of the
  // family above and the only one whose evidence is about *files* rather than about the
  // bead: lib/claims.js has answered "is anyone on this?" since bc-q5c2, and until this
  // it was only ever asked at `PreToolUse`, after a whole session had been spent
  // arriving at the file. On by default, because the read is a map in this process and,
  // until `holdGuessedFiles` below says otherwise, the hold it produces only ever fires
  // on a surface the bead itself declared.
  holdClaimedFiles: true,
  // And whether a surface this daemon *guessed* — paths read out of the bead's own prose
  // — may hold as well, or may only say so. Off, and bc-hrno is the decision: a guess
  // that withholds work is the expensive direction, the same way `withoutTwins` errs
  // toward doing the work twice rather than not at all. Turn it on for a workspace whose
  // beads are written with their files named, and leave it off everywhere else until
  // bc-42ow makes the surface a declared field.
  holdGuessedFiles: false,
  // Hold a bead out of the queue while *another Mac* has claimed it, and stand down when
  // one claims it underneath us — see lib/lease.js, which owns the numbers because it
  // owns the argument for them. The fifth of the family above and the only one whose
  // evidence lives in the shared graph rather than on this laptop: the other four can
  // each see one machine's worth of the world, which is the whole of the problem once a
  // tracker is federated.
  ...LEASE_DEFAULTS,
  sessionLog: true,
  sessionTranscripts: false,
  // Tier 3 (bc-goo.6, lib/agentrepo.js): whether the advocate is given a private repo
  // of its own, and which arm of the experiment each survey runs. `alternate` flips
  // between `blind` and `index` per workspace, which is the only setting that produces
  // a comparison — and the comparison is the finding, not the repo. `off` withdraws
  // the whole affordance, including the write grant; `blind` and `index` pin an arm,
  // which is for reproducing something the log showed rather than for running it.
  agentRepo: 'alternate',
  // Closing the window of a session whose bead is closed — see lib/reap.js, which
  // owns the numbers because it owns every decision they feed.
  ...REAP_DEFAULTS,
};

/** Read-only: the survey agent argues for work, it does not do any. */
// What the survey agent may do lives in lib/foundation.js, with the other three
// agent kinds — see the header there for why one object beats four scattered
// constants. What it is asked stays in `surveyPrompt` below.

export const options = (cfg) => ({ ...DEFAULTS, ...(cfg.advocates || {}) });

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * The attic expiry in days — the one interval here that is deliberately fractional.
 *
 * Every other number in this file is minutes and whole, but this one is the age of a
 * directory that is about to stop existing, and the way you convince yourself of a
 * removal rule is by running it at `0.01` on a real attic first. Nonsense and negative
 * values fall back to the default rather than to zero, because a typo in a config
 * should not silently switch a safety sweep off; an explicit `0` still does, since
 * that is somebody saying they want to keep everything.
 */
const atticDays = (o) => {
  if (o.tidyAtticDays === 0) return 0;
  const n = Number(o.tidyAtticDays);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : DEFAULTS.tidyAtticDays;
};

/**
 * How many sessions this advocate may have open at once.
 *
 * Two numbers, because they answer different questions: `maxWorkers` is what you
 * want, `maxWorkersLimit` is how far you are willing to let any one repo go. The
 * request is clamped to the ceiling rather than refused — a config asking for six
 * should give you the most it will allow, and say so once, not fail to start.
 *
 * ## Per workspace, and deliberately not per repo
 *
 * A workspace used to be a repo, so the question never came up. Climative is the shape
 * that raises it — forty checkouts behind one `cl-` graph — and the answer is that
 * every cap here stays **per workspace**: `maxWorkers` and `launchCooldownSeconds`
 * count one advocate's windows however many repos those windows are spread across, and
 * `globalMaxWorkers` counts every advocate on this Mac at once.
 *
 * It is the right answer because of what these numbers are actually rationing. Not
 * checkouts — this laptop's attention: iTerm windows on one screen, `claude` processes
 * on one CPU, and one person who has to be able to look at the lot. A per-repo cap
 * would make "climative, 1 session at a time" mean *forty* sessions the moment forty
 * repos were approved, and it would mean it without anybody having typed a bigger
 * number anywhere. The cost of the decision is real and is the price: work in two
 * Climative repos is *concurrent* only up to `maxWorkers`, so a workspace that wants
 * two repos moving at once says so by stepping its limit to 2 — one deliberate press,
 * on the card, rather than a cap that quietly scales with the length of a list.
 */
export function workerLimit(cfg, name) {
  const o = options(cfg);
  const ceiling = clampInt(o.maxWorkersLimit, 1, MAX_WORKERS_CEILING, DEFAULTS.maxWorkersLimit);
  const want = o.perWorkspace?.[name]?.maxWorkers ?? o.maxWorkers;
  return { limit: clampInt(want, 1, ceiling, 1), ceiling, requested: Math.floor(Number(want)) || 1 };
}

/**
 * Write one repo's chosen limit to config.json, so a restart still honours it.
 *
 * Per-workspace and never the global `maxWorkers`: one repo's stepper must not move
 * another repo's cap, and `perWorkspace.<repo>.maxWorkers` is the key `workerLimit`
 * already prefers when it recomputes the number at boot.
 *
 * The interesting half is `maxWorkersLimit`. It defaults to 3, so a stepper clamped
 * to it could never take a repo past today's cap and the whole control would do
 * nothing. Pressing the button *is* the statement that this repo may go that far —
 * so the ceiling is raised to meet the number rather than quietly eating it on the
 * next boot, which would be the one failure you could not see from the card. It only
 * ever moves up: stepping back down leaves the permission you already gave in place.
 * The startup warning still fires for a config edited by hand.
 */
export function saveWorkerLimit(cfg, name, limit) {
  const adv = cfg.advocates && typeof cfg.advocates === 'object' ? cfg.advocates : (cfg.advocates = {});
  const per = adv.perWorkspace && typeof adv.perWorkspace === 'object' ? adv.perWorkspace : (adv.perWorkspace = {});
  const entry = per[name] && typeof per[name] === 'object' ? per[name] : (per[name] = {});
  entry.maxWorkers = limit;
  const ceiling = clampInt(adv.maxWorkersLimit, 1, MAX_WORKERS_CEILING, DEFAULTS.maxWorkersLimit);
  if (limit > ceiling) adv.maxWorkersLimit = limit;
  saveConfig(cfg);
  return { maxWorkers: limit, maxWorkersLimit: adv.maxWorkersLimit ?? ceiling };
}

/**
 * The cap across every advocate at once, clamped — the one number that most often
 * actually binds.
 *
 * A function, and exported, because three callers outside the daemon want it and each
 * of them used to write `?? 10` instead: the startup line in bin/beadcause.js, the
 * summary in scripts/configure.js, and the console. A magic number copied into three
 * files is a default that changes in one of them.
 */
export function globalWorkerCap(cfg) {
  const o = options(cfg);
  return clampInt(o.globalMaxWorkers, 1, GLOBAL_WORKERS_CEILING, DEFAULTS.globalMaxWorkers);
}

/**
 * Write the total across every advocate to config.json, so a restart still honours it.
 *
 * The global twin of `saveWorkerLimit`, and simpler for one reason: there is no second
 * key to keep honest. A per-repo limit has a ceiling that has to be raised to meet it
 * or the number silently drops back at boot; this *is* the ceiling, bounded only by
 * `GLOBAL_WORKERS_CEILING`, which is not configurable and so cannot drift.
 */
export function saveGlobalWorkerLimit(cfg, limit) {
  const adv = cfg.advocates && typeof cfg.advocates === 'object' ? cfg.advocates : (cfg.advocates = {});
  adv.globalMaxWorkers = limit;
  saveConfig(cfg);
  return { globalMaxWorkers: limit };
}

/** Which workspaces have an advocate at all. `["*"]` means every configured one. */
export function advocatedWorkspaces(cfg) {
  const o = options(cfg);
  if (!o.enabled) return [];
  const want = o.workspaces === '*' ? ['*'] : Array.isArray(o.workspaces) ? o.workspaces : [];
  const all = cfg.workspaces || [];
  const picked = want.includes('*') ? all : all.filter((w) => want.includes(w.name));
  // A space can veto its workspaces the same way it vetoes auto-dispatch: one
  // setting on the group keeps applying as you add repos to it, which is exactly
  // the drift a per-workspace list gets wrong.
  return picked.filter((w) => spaceFor(cfg, w.name)?.advocate !== false);
}

/* ------------------------------------------------------------------- state */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(STATE_PATH, state);
    snapshot('advocates');
  } catch (err) {
    console.error(`[advocate] could not save state: ${err.message}`);
  }
}

/** Highest priority first, then oldest — the order an advocate picks work up in. */
const byPickOrder = (x, y) => x.priority - y.priority || String(x.createdAt).localeCompare(String(y.createdAt));

const iso = () => new Date().toISOString();
const minsSince = (at) => (at ? (Date.now() - new Date(at).getTime()) / 60000 : Infinity);
const secsSince = (at) => (at ? (Date.now() - new Date(at).getTime()) / 1000 : Infinity);

/* ------------------------------------------------------------------ the thing */

/**
 * Does this check-in answer the question that was asked?
 *
 * A rule rather than an inline comparison because it is the one place the feature can
 * go wrong invisibly: an older check-in still sitting on disk would answer every
 * future question, and a session that had hung since would keep its slot forever. Both
 * are ISO strings from one clock, so `>` is the whole test — and "no file" is a
 * perfectly ordinary no.
 */
export const answersCheckin = (askedAt, said) => Boolean(askedAt && said?.at && said.at > askedAt);

/**
 * Is `id` underneath `ancestor` in the bead hierarchy?
 *
 * bd puts hierarchy in the id: a child of `bc-3zo9` is `bc-3zo9.1`, its own child is
 * `bc-3zo9.1.4`. That is the same fact `namesBead` in lib/reap.js leans on, and it is
 * worth leaning on here because the alternative — asking bd for the parent of every
 * ready bead — is a call per bead per tick to learn something already written down.
 *
 * The dot is required rather than a bare prefix, for the reason reap.js gives: without
 * it `bc-3z` would swallow `bc-3zo9`, and an advocate would hold back work on the
 * strength of two ids that merely start alike.
 */
export const isDescendantOf = (id, ancestor) => Boolean(id && ancestor && String(id).startsWith(`${ancestor}.`));

/**
 * Everything above a bead in the hierarchy — `x-1.2.3` → `['x-1.2', 'x-1']`, nearest
 * first — read off the id for the same reason `isDescendantOf` is.
 *
 * The other direction from `isDescendantOf`, and the reason it exists separately is that
 * the questions are asked of different things: that one is handed a candidate and asks
 * whether it is below a bead this process already knows about, which is a comparison. This
 * one is handed a bead and asks *what to go and read* — the ids of the beads whose labels
 * might say another machine is already in this subtree. There is no list to compare
 * against there, so the ids have to be produced rather than filtered.
 *
 * Nearest first, because the nearest holder is the more useful one to name on the card:
 * "x-1.2 is above it" points at the window actually doing the work, where the epic three
 * levels up would only point at the tree. And empty for a bead with no parent, which is
 * most beads — see `leaseHolderAbove` on why that emptiness is what makes this affordable.
 */
export const ancestorsOf = (id) => {
  const out = [];
  let cur = String(id || '');
  for (;;) {
    const cut = cur.lastIndexOf('.');
    // `<= 0` and not `< 0`: a leading dot is not a hierarchy, it is a malformed id, and
    // slicing it to the empty string would produce an "ancestor" every bead is under.
    if (cut <= 0) return out;
    cur = cur.slice(0, cut);
    out.push(cur);
  }
};

/**
 * `say`, `open` and `openPlan` are the three things this does *to* a Mac, and all of them
 * are injectable for the same reason: the real ones drive iTerm through an Apple event,
 * which no test suite should need — and two of them open a window, which is the single
 * thing a test must never do by accident. A suite asserting "the tick did not open a
 * session on this bead" is worthless if the way it fails is by opening one. `openPlan` is
 * separate from `open` rather than a flag on it because the two write different briefs to
 * different ends, and a test that cannot tell which of them ran cannot assert the thing
 * bc-jk4m is about. Everything else takes the default.
 */
export function createAdvocates(cfg, { bd, bus, say = messageSession, open = openWorkSession, openPlan = openPlanSession, prs = openWork }) {
  const o = options(cfg);
  const saved = loadState();
  /**
   * Who this Mac is, for the lease — or null, which is every install that has never
   * heard of federation and is the state in which none of lib/lease.js runs at all.
   *
   * Read once here rather than per tick because it comes from `cfg.me`, which the daemon
   * reloads by restarting; and read through `handleFor` rather than off `cfg` directly so
   * that "a machine that calls itself everyone is nobody" stays one rule in one file.
   */
  const me = handleFor(cfg);
  /** Is the cross-machine lease running at all? Off with no handle, and off when told. */
  const leasing = () => Boolean(me) && o.holdLeases !== false;
  const leaseOpts = () => ({ minutes: o.leaseMinutes ?? LEASE_DEFAULTS.leaseMinutes });
  /** @type {Map<string, any>} one record per advocated workspace. */
  const advocates = new Map();
  let ticking = false;

  for (const ws of advocatedWorkspaces(cfg)) {
    const prev = saved[ws.name] || {};
    const { limit, ceiling, requested } = workerLimit(cfg, ws.name);
    if (requested > ceiling) {
      console.warn(
        `[advocate] ${ws.name}: maxWorkers ${requested} exceeds maxWorkersLimit ${ceiling} — using ${limit}`
      );
    }
    advocates.set(ws.name, {
      workspace: ws,
      name: ws.name,
      limit,
      // Survives a restart: a paused advocate that resumed itself on a `launchctl
      // kickstart` would be the least trustworthy thing in the program.
      paused: Boolean(prev.paused),
      // Also survives a restart, and must: the iTerm windows it opened are still
      // open, and forgetting them is how you get four sessions on one bead.
      workers: Array.isArray(prev.workers) ? prev.workers : [],
      // Windows whose bead is closed and whose process is still there, waiting out
      // the grace period before they are signalled. Carried across a restart for the
      // same reason `workers` is — the windows are still open, and a daemon that
      // forgot them would leave the pile it was written to clear.
      closing: Array.isArray(prev.closing) ? prev.closing : [],
      attempts: prev.attempts || {},
      lastProposalAt: prev.lastProposalAt || null,
      lastLaunchAt: prev.lastLaunchAt || null,
      lastTidyAt: prev.lastTidyAt || null,
      // When the window sweep last looked. Persisted so a daemon restarted every few
      // minutes does not turn a 5-minute interval into a `bd show` per candidate per
      // boot — and null, on a first run, means it looks immediately.
      lastWindowSweepAt: prev.lastWindowSweepAt || null,
      // Not carried across a restart, unlike the tidy sweep's clock: a daemon that has
      // just come up is exactly when a merge it never saw is most likely to be sitting
      // there, so the first tick asks GitHub rather than waiting out the interval.
      lastLandedAt: null,
      // Same reasoning, and it bites harder: a bead marked superseded while the daemon
      // was down is held out of every queue by a marker only this sweep can act on, so
      // waiting out an interval before the first look is ten minutes of a bead nobody
      // can see.
      lastSupersededAt: null,
      // And again: a branch that landed while the daemon was down is the likeliest kind
      // there is, since a restart usually follows a merge.
      lastInMainAt: null,
      // And once more, with the least urgency of the four: a bead closed over an unlanded
      // branch has been that way since before the daemon went down. Null all the same,
      // because the alternative is an hour of not looking after every restart, and
      // restarts here are frequent.
      lastNotInMainAt: null,
      lastSurveyAt: null,
      tidy: null,
      landed: null,
      superseded: null,
      inMain: null,
      notInMain: null,
      lastArchive: prev.lastArchive || null,
      // Sessions whose branch had not reached main when they were archived. The
      // note on the landing can only be written once there is a landing, and that
      // is usually hours later — so it is carried across restarts rather than lost.
      pendingNotes: Array.isArray(prev.pendingNotes) ? prev.pendingNotes : [],
      finished: [],
      // The first sweep of a restart runs on the first tick rather than waiting out
      // the interval: a daemon that has just come up is exactly when the leftovers
      // of whatever happened while it was down are sitting there.
      sweepDue: true,
      queue: [],
      // Ready beads the survey took out of the queue because they name no checkout
      // this workspace can be worked in — a `repo:` token nothing approved declares,
      // or one two approved repos both declare. The only hold here that waiting will
      // never resolve, which is why it is on the card. See `withoutUnplaceable`.
      heldByRepo: [],
      // Ready beads the survey took out of the queue because their children are the
      // work — carried on the card, not just dropped. See `heldByChildren`.
      heldByChildren: [],
      // And the ones it took out because another bead is the same job and is already
      // being worked. Same contract: held, and said out loud. See `withoutTwins`.
      heldByTwin: [],
      // And the ones it took out because a pull request already carries the work. Same
      // contract again, and the strongest evidence of the three: a branch with commits
      // on it rather than a resemblance. See `withoutOpenPrs` and lib/inflight.js.
      heldByPr: [],
      // And the ones it took out because a window is already open on them. The last of
      // the four, and the only one whose evidence is a running process rather than
      // anything in the tracker. See `withoutLiveSessions` and bc-vq78.
      heldByLive: [],
      // And the ones another Mac has claimed in the shared tracker. The fifth, and the
      // only one whose evidence came over the network — every other filter here can see
      // exactly one machine's worth of the world. See `withoutLeases` and lib/lease.js.
      heldByLease: [],
      // And the ones held because another session on this Mac is editing the very files
      // they would touch. The sixth, and the only one whose evidence is neither about the
      // bead nor about a window but about a *file* — see `withoutClaimedFiles`.
      heldByClaim: [],
      // And the ones held because nothing on the board has decided they should happen:
      // not a P0, and no P0 anywhere above them. The seventh, and the only one that is
      // not about contention at all — every other hold here is two things wanting the
      // same bead, a window, a branch or a file, and this one is a bead nobody put on
      // the board. See `withoutOrphans` and lib/underp0.js.
      heldByNoP0: [],
      // The near miss, and the reason it is a separate list: beads whose files somebody is
      // editing which were dispatched **anyway**, because the surface was guessed from
      // prose rather than declared (bc-hrno). Nothing was held, so calling it held would be
      // a lie — but a window opened straight into a file another session has its hands on
      // is worth one line on the card, which is where a person notices the pattern.
      filesBusy: [],
      // Windows this advocate stood down because another Mac's claim won the tiebreak.
      // Carried on the card rather than only logged, because a session withdrawn with
      // nothing on screen is indistinguishable from one that finished. Trimmed by age in
      // `standDown`, so a busy hour cannot turn the card into a history.
      stoodDown: [],
      // The session records that filter reads, replaced at the top of every tick from
      // the one snapshot every advocate is matched against, and again before a launch.
      liveSessions: [],
      // What the last open-PR read found, kept between reads because it is asked on an
      // interval rather than on every tick: bead id → the pull request carrying it.
      openPrs: new Map(),
      inflight: null,
      lastInflightAt: null,
      note: '',
      error: null,
      surveying: false,
      quiet: false,
    });
  }

  function persist() {
    const out = {};
    for (const [name, a] of advocates) {
      out[name] = {
        paused: a.paused,
        workers: a.workers,
        closing: a.closing,
        attempts: a.attempts,
        lastProposalAt: a.lastProposalAt,
        lastLaunchAt: a.lastLaunchAt,
        lastTidyAt: a.lastTidyAt,
        lastWindowSweepAt: a.lastWindowSweepAt,
        lastArchive: a.lastArchive,
        pendingNotes: a.pendingNotes,
      };
    }
    saveState(out);
  }

  const totalWorkers = () => [...advocates.values()].reduce((n, a) => n + a.workers.length, 0);

  /**
   * The cap across every advocate at once, which no per-repo limit can talk past.
   *
   * A function rather than the inline expression it used to be, because the card now
   * needs the same number: a repo stepped up to 5 under a global cap of 3 is not
   * broken and is not going to get 5, and the only honest thing to do is say which
   * number is actually binding. Two places computing it separately is how the card
   * ends up quoting a cap the tick does not use.
   */
  const globalLimit = () =>
    clampInt(o.globalMaxWorkers, 1, GLOBAL_WORKERS_CEILING, DEFAULTS.globalMaxWorkers);

  /**
   * The same number, changed while the daemon runs — the global half of `control`'s
   * `limit` action, and the reason the console no longer has one setting on it you
   * have to leave the app to change.
   *
   * `o` is the daemon's own options object, so writing to it is the whole of the live
   * half: the next tick, thirty seconds away, computes `globalFree` from the new number
   * and no restart is involved. `saveGlobalWorkerLimit` is the other half, and it is
   * the one whose absence you would not notice for a day.
   *
   * Out of range clamps and no number at all is a 400, for exactly the reasons the
   * per-repo stepper does both — see the `limit` branch of `control`. `Number(null)` is
   * 0, so folding a missing value into the clamp would read as a deliberate "one
   * session on this whole Mac", which is not a thing anybody has ever meant to press.
   */
  function setGlobalLimit(value) {
    const asked = typeof value === 'string' ? value.trim() : value;
    if (asked === '' || asked == null || !Number.isFinite(Number(asked))) {
      throw Object.assign(new Error(`globalLimit needs a number, got ${JSON.stringify(value) ?? typeof value}`), {
        status: 400,
      });
    }
    const next = clampInt(asked, 1, GLOBAL_WORKERS_CEILING, globalLimit());
    o.globalMaxWorkers = next;
    // Every advocate's note may quote this number — "held by globalMaxWorkers (10)" is
    // written by `tickOne` and survives until the next tick rewrites it. Dropping them
    // all is what stops six cards contradicting the number you just pressed.
    for (const a of advocates.values()) a.note = '';
    saveGlobalWorkerLimit(cfg, next);
    console.log(`[advocate] global cap set to ${next} session(s) across every advocate`);
    // Once per advocate, because the bus is keyed by workspace and this changed
    // something about every one of them — a repo that was held by the old number and
    // is about to launch should say why in its own transcript, not in a global one
    // nobody opens.
    for (const a of advocates.values()) {
      emit(a, 'globalLimit', { detail: `global cap set to ${next} session(s) across every advocate` });
    }
    return next;
  }

  /** Say it once. An advocate ticks every 30s and would otherwise fill the log. */
  function note(a, text, level = 'log') {
    if (a.note === text) return;
    a.note = text;
    if (text) console[level === 'warn' ? 'warn' : 'log'](`[advocate] ${a.name}: ${text}`);
  }

  function emit(a, action, extra = {}) {
    bus?.emit({ type: 'advocate', key: extra.id ? `${a.name}/${extra.id}` : a.name, workspace: a.name, action, ...extra });
  }

  /* --------------------------------------------------------- many checkouts */

  /**
   * Every checkout this advocate spans, and what each of them is called.
   *
   * One advocate is one *workspace*, and for every workspace on almost every install
   * that is also one repo — `sophab`, `deluvia`, `beadcause` itself. Climative is the
   * shape that breaks it: forty-odd repos behind one `cl-` graph, because only
   * `architecture` has beads installed and everything else files into it (lib/repos.js).
   *
   * So every sweep that asks a *checkout* something — which pull requests are open,
   * which branches reached `main` — has to ask all of them. Asking one is not a
   * cheaper approximation of asking all: it is the wrong answer with no way to tell,
   * because a bead whose work sits in an open pull request in `athena-service` looks,
   * to a sweep that only ever asked `architecture`, exactly like a bead nobody has
   * started. That is bc-utyr's incident with the repo name changed.
   *
   * An empty list is a real answer and every caller treats it as one: a scratch
   * tracker under `~/beads` with no checkout at all, and a `repos` block whose approved
   * repos are none of them on disk, both land here. Nothing is swept, and nothing is
   * an error.
   */
  function repoDirs(a) {
    if (!multiRepo(cfg, a.name)) {
      try {
        return [{ name: null, dir: resolveSessionDir(cfg, a.workspace), token: null }];
      } catch {
        // No directory maps to this workspace, so there is no repo to ask about — the
        // ordinary state of a scratch tracker, and not an error.
        return [];
      }
    }
    return repoList(cfg, a.name).repos.map((r) => ({ name: r.name, dir: r.dir, token: r.token }));
  }

  /** `athena-service: ` before a sweep's complaint — nothing at all where there is one repo. */
  const inWhich = (repo) => (repo.name ? `${repo.name}: ` : '');

  /**
   * Which approved checkout a directory *is*, for the row on the card.
   *
   * Read off the directory a launch actually opened in rather than off the bead's
   * label, and that is the point: the label says where a session was meant to go, the
   * directory says where it went, and a card that quoted the first would keep saying
   * `athena-service` however the launch had resolved. Null for every single-repo
   * workspace, which is what stops "climative" appearing beside every sophab worker.
   */
  function repoNameFor(a, dir) {
    if (!dir || !multiRepo(cfg, a.name)) return null;
    const want = path.resolve(dir);
    return repoList(cfg, a.name).repos.find((r) => path.resolve(r.dir) === want)?.name || null;
  }

  /**
   * The checkout a queued bead names, or the sentence saying it names none.
   *
   * Both halves of the answer come from lib/repos.js and neither is guessed at: a bead
   * carrying no `repo:` label belongs to the list's `default` repo, and a bead whose
   * token nothing approved declares — or that two approved repos both declare — has no
   * checkout at all and gets `problem` instead. `resolveSessionRepo` throws on exactly
   * the same cases at launch time; this asks the question one step earlier, where the
   * answer can be a pill instead of a stack trace.
   *
   * Gated on `multiRepo` so an ordinary workspace pays nothing: no label read, no
   * `statSync` per approved repo, and no way for a stray `repo:` label on a beadcause
   * bead to hold it out of a queue that has no repos to place it in.
   */
  function placeFor(a, row) {
    if (!multiRepo(cfg, a.name)) return { repo: null, problem: null };
    const { token, problem } = beadToken(row);
    if (problem) return { repo: null, problem };
    const placed = resolveRepo(cfg, a.name, token);
    return { repo: placed.repo?.name || null, problem: placed.problem || null };
  }

  /**
   * The paragraph that tells the survey agent it is standing in one of many checkouts.
   *
   * Empty for every single-repo workspace, which is the point at which this costs
   * nothing — no list is read, no path is named, and the prompt is the prompt it has
   * always been. See `surveyAgent` for why the survey is one run across N repos rather
   * than N runs.
   *
   * The `repo:` label is the half worth spelling out. Everything else here the agent
   * could work out by looking; that one it could not, because a bead filed without a
   * token is not refused — it *resolves*, to the `default` checkout (lib/repos.js). So
   * work found one repo along and proposed without a label reads perfectly well on the
   * card, is approved, and opens its session in the wrong tree.
   */
  function checkoutBrief(a, here, others) {
    if (!others.length) return '';
    const rows = repoDirs(a).map(
      (r) =>
        `- **${r.name}** — \`${r.dir}\`${r.token ? ` (service token \`${r.token}\`)` : ''}` +
        `${path.resolve(r.dir) === path.resolve(here) ? ' ← you are here' : ''}`
    );
    return `**This workspace is ${rows.length} checkouts, and you can read all of them.** One tracker,
${rows.length} repos: the queue you are surveying spans the lot, so "is this genuinely finished"
is a question about all of them and not about the one you are standing in.

${rows.join('\n')}

They are on your command line, so an absolute path into any of them reads. \`git log\`,
\`grep\` and the README are **per checkout** — run them in the directory you mean, and say
in the description which repo the files you name are in, because whoever opens the bead
cold will be somewhere else.

**Say which checkout each bead is about, or it goes to the wrong one.** A proposed bead
carrying no \`repo:\` label belongs to the default checkout, which for work you found
anywhere else is silently wrong — the card reads fine and the session opens in the wrong
tree. Put that repo's service token on it:

\`\`\`
    labels: [repo:<token>]
\`\`\`
`;
  }

  /* ------------------------------------------------------------ the survey */

  /**
   * What counts as work.
   *
   * `bd ready` already excludes in_progress, blocked, deferred and hooked, which is
   * most of the definition — an advocate that pushed at blocked beads would be
   * pushing at something only another bead can move. On top of that: questions are
   * yours, not its; a bead still waiting for your endorsement is nobody's yet, and
   * nothing may open a session on one at all (see lib/endorse.js); and P4 is a
   * backlog, which is a list of things deliberately not being done. The priority
   * floor is configurable, and the numbers say which is which on the card rather
   * than silently shrinking the queue.
   *
   * And then there is hierarchy, which `bd ready` does not model at all: a parent is
   * not blocked by its children — no dependency edge is written between them — so an
   * epic with five open children is genuinely ready by bd's own semantics. It is not
   * ready by ours. See `heldByChildren`.
   *
   * Everything this advocate later reports as "N ready" is `a.queue`, which is this
   * list — so excluding held beads here is also what keeps them out of the count.
   */
  async function survey(a) {
    const rows = await bd.ready(a.workspace, { excludeLabels: QUEUE_EXCLUDED });
    const max = clampInt(o.minPriority, 0, 4, DEFAULTS.minPriority);
    const kept = rows.filter((r) => (r.priority ?? 2) <= max);
    a.deferredByPriority = rows.length - kept.length;
    const ranked = kept
      .map((r) => {
        // Which checkout this bead is about, resolved once here rather than at each of
        // the four places downstream that want it — the pill, the launch, the log line
        // and the row on the card — so they cannot disagree about where it would go.
        const where = placeFor(a, r);
        return {
          id: r.id,
          title: r.title || r.id,
          priority: r.priority ?? 2,
          type: r.issue_type || 'task',
          createdAt: r.created_at || null,
          updatedAt: r.updated_at || r.created_at || null,
          // Carried, and the one field here that is not for the card: this row is what
          // `launch` hands to `openWorkSession`, and the `repo:` label is what that has
          // to read to open the window in the right checkout. A queue entry that dropped
          // the labels would resolve every Climative bead to the default repo — silently,
          // because the launch would succeed and only the directory would be wrong.
          labels: r.labels || [],
          repo: where.repo,
          repoProblem: where.problem,
        };
      })
      // Sorted here, not only where the launch is chosen, because the card shows
      // the head of this list as "next": bd's own order is close but not the same,
      // and a "next" that isn't what gets picked is a lie with no upside.
      .sort(byPickOrder);

    // And then the one subtraction that happens before anything reads the queue at all:
    // a bead with no P0 above it is not work, so it must be gone before a plan can name
    // it, a batch can fold it in, or the card can count it. See `withoutOrphans`.
    const queue = await withoutOrphans(a, ranked);

    // The labels came back with the rows and the queue row is deliberately narrow — see
    // `withoutLeases`, which is the only filter here whose evidence is on the bead itself
    // rather than in something this daemon went and read. Kept beside the queue rather
    // than folded into it so that nothing widened travels to the card in `next`.
    const labels = new Map(rows.map((r) => [r.id, r.labels || []]));
    // And the rows themselves, by id, for the one question that is asked of a bead which is
    // not in the queue at all: `leaseHolderAbove` wants an *ancestor's* labels and type, and
    // an ancestor that happens to be ready is one already in hand. Same reason as `labels` —
    // narrow rows travel to the card, whole ones stay here. See `leaseHolderAbove` for what
    // it costs when the ancestor is not among them, which is the usual case.
    const kin = new Map(rows.map((r) => [r.id, r]));

    // What has been *planned* is decided first, and everything else defers to it: a plan is
    // a judgement somebody made about this subtree and the two below are rules this file
    // invented. `planned` is what it hands the mechanical grouping so the two cannot both
    // dispatch one subtree. See `plansFor`.
    const {
      planned,
      groupOf,
      plannedInto,
      awaiting,
      plannerOf: replanOf,
      epicHold,
      promotable,
    } = await plansFor(a, queue, labels);
    // Read by `promote`, after the survey rather than inside it: a survey only looks, and
    // this one runs twice in a tick when `landed` moved something.
    a.promotable = promotable;

    // Batching is decided over the whole queue before any bead is judged on its own,
    // because it is a fact about a subtree rather than about a bead: the pick order can
    // reach a child long before its epic, and "is this bead folded into a batch" has no
    // answer until every epic has had its turn to claim one. See `batchesFor`.
    const { batchOf, plannerOf, foldedInto } = await batchesFor(a, queue, planned);

    const workable = [];
    const held = [];
    // `queue` and not `placed` as the second argument: hierarchy is a fact about the
    // ids and must answer the same whether or not a child happens to name a checkout
    // nothing can resolve. Only the *iteration* is narrowed, so an unplaceable bead
    // never costs the `bd children` call an epic would.
    for (const bead of withoutUnplaceable(a, queue)) {
      // Everything a plan decided comes first, in the order a bead can be in only one of
      // them: the lead of a dispatched group, another bead of that group, a bead nobody has
      // grouped yet, or the planned epic itself.
      const group = groupOf.get(bead.id);
      if (group) {
        workable.push({ ...bead, group });
        continue;
      }
      const lead = plannedInto.get(bead.id);
      if (lead) {
        const epicOf = groupOf.get(lead)?.epic;
        held.push({ id: bead.id, why: epicOf ? `grouped under ${lead} in ${epicOf}'s plan` : `a session is working ${lead}, which is in its group` });
        continue;
      }
      const replanning = awaiting.get(bead.id);
      if (replanning) {
        held.push({ id: bead.id, why: `waiting on ${replanning}'s plan, which is being revised` });
        continue;
      }
      const replan = replanOf.get(bead.id);
      if (replan) {
        // Re-entry: this epic has a plan, and something is ready under it that no group
        // names. A planner rather than a worker — `launch` reads `planner` and opens the
        // other brief. See `plansFor`.
        workable.push({ ...bead, planner: replan, revising: true });
        continue;
      }
      const plannedWhy = epicHold.get(bead.id);
      if (plannedWhy) {
        held.push({ id: bead.id, why: plannedWhy });
        continue;
      }
      // A child its epic now speaks for. Carried on the card like anything else this
      // filter removes — a queue one shorter than `bd ready` with nothing on screen
      // accounting for the difference reads exactly like an idle advocate.
      const epicId = foldedInto.get(bead.id);
      if (epicId) {
        if (plannerOf.has(epicId)) {
          held.push({ id: bead.id, why: `waiting to be grouped into ${epicId}'s plan` });
          continue;
        }
        const inBrief = (batchOf.get(epicId) || []).some((k) => k.id === bead.id);
        held.push({ id: bead.id, why: inBrief ? `batched under ${epicId}` : `waiting for room in ${epicId}'s batch` });
        continue;
      }
      // An epic that will be planned rather than worked. Same inversion as the batch below
      // it and for the same reason — it is workable *because* it has ready children — and
      // the difference is only which brief `launch` writes. See `batchesFor`.
      const toPlan = plannerOf.get(bead.id);
      if (toPlan) {
        workable.push({ ...bead, planner: toPlan, revising: false });
        continue;
      }
      const batch = batchOf.get(bead.id);
      if (batch) {
        // The inversion: this epic is workable *because* it has ready children, where
        // `heldByChildren` would have held it back for exactly the same reason.
        workable.push({ ...bead, batch });
        continue;
      }
      const why = await heldByChildren(a, bead, queue);
      if (why) held.push({ id: bead.id, why });
      else workable.push(bead);
    }
    a.heldByChildren = held;
    // Outermost, and last of the six on purpose: it is the newest reason and the only one
    // whose evidence is a *file* rather than the bead, so a bead any of the other five
    // would also hold reads better as "a window is already open on it" than as "somebody
    // is editing lib/advocate.js". It is also what makes the self-collision impossible —
    // a bead whose own session holds those files was taken out by `withoutLiveSessions`
    // one call in. `kin` travels because the surface is read from the bead's whole row,
    // and the queue row is deliberately narrow. See lib/beadfiles.js.
    return withoutClaimedFiles(
      a,
      withoutLiveSessions(
        a,
        withoutOpenPrs(a, await withoutTwins(a, await withoutLeases(a, workable, labels, kin)))
      ),
      kin
    );
  }

  /**
   * The bead another Mac has already claimed, held rather than opened a second time.
   *
   * Innermost of the chain, so it gets first refusal, and that is deliberate: it is the
   * only filter that can name *which machine* is on the bead, so a bead this and the twin
   * filter would both hold reads better as "beta's Mac has it" than as "something here
   * looks like it". (`heldByChildren` still runs ahead of the chain, because a parent
   * whose children are the work is not this machine's business either way.) It is also
   * very nearly free
   * — the evidence for the bead itself arrived with the `bd ready` rows, so there is no
   * read to throttle and nothing to force before a launch, which is why this filter has
   * no counterpart in `tickOne`'s pre-launch re-reads. What moves inside a tick is a `gh`
   * call or a process appearing; a label cannot change without a sync, and a sync is
   * minutes wide. `leaseHolderAbove` is the one part that can cost a read, and it costs
   * none at all for a bead with no parent.
   *
   * **Two ways the claim can be somewhere else, and the second is bc-etbq.** A claim on
   * the bead itself is the straightforward one. A claim on an *epic above* it is the same
   * fact one level up: the other machine's window is responsible for a subtree, and this
   * bead is inside it. That is the hole a batch head opens — one window, several beads, and
   * only the epic leased. `heldByChildren` closes it for this laptop off `a.workers`;
   * `leaseHolderAbove` closes it for every other laptop off a label, which says a machine
   * and a moment and nothing about what that window took on.
   *
   * Only somebody else's claim holds. This machine's own lease on a ready bead is a
   * *released* one — the worker ended, or the delivery reopened it — and holding a bead
   * behind our own claim would be an advocate refusing its own work forever. Expiry is
   * lib/lease.js's, and it is what stops a Mac that went to sleep parking a bead: a claim
   * older than `leaseMinutes` is not a holder, and the bead comes back on its own — which
   * is also the bound on how long an ancestor's claim can park a subtree.
   */
  async function withoutLeases(a, queue, labels, kin = null) {
    const alreadySaid = new Set((a.heldByLease || []).map((h) => h.id));
    a.heldByLease = [];
    if (!leasing() || !queue.length) return queue;

    const now = new Date();
    // One per survey, shared by every bead in it: siblings have the same ancestors, so an
    // epic with five ready children is one read rather than five.
    const above = new Map();
    const workable = [];
    for (const bead of queue) {
      const v = leaseVerdict(labels.get(bead.id) || [], me, { now, ...leaseOpts() });
      let holder = v.lost ? v.holder : null;
      let why = holder ? describeLease(holder, { now }) : null;
      if (!holder) {
        // Asked only of the beads no claim of their own held: a bead already out of the
        // queue does not need a second reason, and the sentence naming its own holder is
        // the more direct of the two.
        const up = await leaseHolderAbove(a, bead.id, { kin, now, cache: above });
        if (up) {
          holder = up.holder;
          why = `${describeLease(holder, { now })} on ${up.ancestor}, which is above it`;
        }
      }
      if (!holder) {
        workable.push(bead);
        continue;
      }
      a.heldByLease.push({ id: bead.id, why, handle: holder.handle, at: holder.at });
      // Once per bead per spell of being held, like the three filters below it: a bead
      // another Mac worked all afternoon would otherwise be hundreds of identical lines.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
    }
    return workable;
  }

  /**
   * Another Mac's live claim on an *epic above* this bead, or null — `heldByChildren`'s
   * upward check, asked of the shared tracker rather than of `a.workers`.
   *
   * bc-etbq, and the failure is bc-thid's with the guard removed. Mac A opens a batch head
   * on epic x-1 carrying x-1.1 .. x-1.5, and leases x-1 — the bead it was launched on. Mac B
   * syncs, holds x-1 correctly because it can see that claim, and then opens a window on
   * x-1.1: nothing leases x-1.1, and the worker that would have held it back is in an
   * `a.workers` on the other machine. Two windows in one subtree, two branches carrying the
   * same work, which is the exact thing lib/lease.js exists to prevent — it just prevented
   * it a bead at a time, and a batch is the first thing here that makes one window
   * responsible for several.
   *
   * **Any ancestor, which is the same reach `heldByChildren` gives `above` and for the same
   * reason.** It was epics only until bc-zgfo, on the argument that a batch head is always
   * an epic and a session on a *plain* parent speaks only for its own bead. bc-zgfo took
   * that qualifier off the local rule, and this one has to follow in the same commit: the
   * two must not resolve the same pair of beads one way when the window is on this Mac and
   * another way when it is on the next desk, and the whole reason this function exists is
   * that the desk is the only difference between them.
   *
   * It is free. The type test sat *after* the `bd show` — the read was already paid for
   * before a non-epic ancestor was discarded — so widening it removes a `continue` and adds
   * no call. Which also closes half of bc-9otk by the side door: another Mac's claim on a
   * plain task now holds that task's subtasks here, where before it held nothing.
   *
   * Everything else about the ancestor is unknowable from here and deliberately not guessed
   * at. Whether that window actually took a batch, what it was briefed on, whether it is
   * still typing — a label says a machine and a moment. Given only that, holding the subtree
   * is the cheaper mistake and a self-cancelling one: the claim comes off when the worker
   * ends, expires on `leaseMinutes` if the Mac went to sleep, and while it lasts the hold is
   * on the card with the handle of the person to go and ask.
   *
   * **What it costs.** Nothing for a bead with no parent, which is most beads: `ancestorsOf`
   * is empty and the loop does not run. Nothing for a single-person install, because the
   * caller has already returned on `leasing()`. Otherwise one `bd show` per ancestor per
   * pass, cached across the queue — and none at all for an ancestor that is itself ready,
   * because `kin` is this tick's `bd ready` rows and the read is only for the ancestor that
   * is *not* in them: claimed, blocked, or under the priority floor. `reconcile` has no such
   * rows and passes none, which is one read per ancestor of a live worker's bead.
   *
   * A `bd` that will not answer holds nothing back, exactly as in `heldByChildren`: a
   * tracker mid-write must not be able to empty an advocate's queue. What that costs is one
   * tick's worth of exposure to the race this closes, and the two halves are each other's
   * backstop — the filter catches it before a window opens, `reconcile` after.
   */
  async function leaseHolderAbove(a, id, { kin = null, now = new Date(), cache = new Map() } = {}) {
    for (const ancestor of ancestorsOf(id)) {
      let row = kin?.get(ancestor);
      if (row === undefined) {
        if (!cache.has(ancestor)) {
          try {
            cache.set(ancestor, await bd.show(a.workspace, ancestor));
          } catch {
            // Cannot tell, which is not "nobody holds it" — but it is not grounds to hold a
            // bead either. Null rather than an empty row so that a retry on a later tick is
            // not answered out of this cache.
            cache.set(ancestor, null);
          }
        }
        row = cache.get(ancestor);
      }
      if (!row) continue;
      const v = leaseVerdict(row.labels || [], me, { now, ...leaseOpts() });
      if (v.lost) return { ancestor, holder: v.holder };
    }
    return null;
  }

  /**
   * The bead that names no checkout this workspace can work in, held rather than
   * handed to a launch that will refuse it.
   *
   * First of the queue's five subtractions to run, newest of them, and the only one that
   * is about *where* rather than *whether*. `resolveSessionRepo` already refuses an unknown token, a token two
   * approved repos both declare, and a bead labelled `repo:` twice — deliberately,
   * because falling back to `architecture` is how work aimed at one service quietly
   * lands in the repo that holds the workspace's Dolt remote. But a refusal at launch
   * time is the wrong place for it to surface twice over: it costs the bead one of its
   * `maxAttemptsPerBead`, and `break` in the launch loop treats it like iTerm refusing,
   * so one mislabelled bead stops every other repo's launch for the whole tick.
   *
   * Held here, it costs neither: the count is on the card with the sentence
   * lib/repos.js wrote attached, and the fix — approve the repo, or correct the label —
   * is one edit that brings the bead straight back. It is the one hold in the family
   * that no amount of waiting resolves, which is exactly why it has to be *said*.
   *
   * Nothing at all happens for a single-repo workspace: `placeFor` returns no problem
   * without reading a label, so this loop finds nothing to hold and the list is
   * returned unchanged.
   */
  function withoutUnplaceable(a, queue) {
    const alreadySaid = new Set((a.heldByRepo || []).map((h) => h.id));
    a.heldByRepo = [];
    if (!queue.length || !multiRepo(cfg, a.name)) return queue;

    const workable = [];
    for (const bead of queue) {
      if (!bead.repoProblem) {
        workable.push(bead);
        continue;
      }
      a.heldByRepo.push({ id: bead.id, why: bead.repoProblem });
      // Once per bead per spell of being held, like every other filter here: a bead
      // mislabelled on Friday would otherwise be 2,880 identical lines by Saturday.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${bead.repoProblem}`);
    }
    return workable;
  }

  /**
   * The bead somebody is already sitting in, held rather than opened a second time.
   *
   * bc-vq78 is what it costs. Two windows were open on climative/cl-xe2 at once: one
   * busy and writing files, the other handed the same bead with a plain brief and told
   * by that brief that claiming it "is what stops a second session being opened on top
   * of you". It found out an hour in, by noticing files it had not written changing
   * mtime. cl-xe2 spanned ten repos, both windows shared the same uncommitted
   * worktrees, and nothing but luck kept that from being a corruption rather than a
   * waste.
   *
   * The claim is not the guard it is advertised as, because things legitimately take it
   * off again. "Request changes" on a delivery card reopens the bead and drops the
   * assignee (`bd.reopen`, lib/server.js) — that is the only signal an advocate reads,
   * and the session that built the branch is usually still sitting there. `reconcile`
   * lets a worker's slot go on a timeout or an unanswered check-in without the window
   * having gone anywhere. A daemon restarted mid-session forgets its workers entirely.
   * Every one of those puts a bead back in `bd ready` with a live window on it.
   *
   * So the evidence here is the window itself: a running Claude Code process whose name
   * carries this bead's id. That is what `reap` already trusts to decide which window to
   * close (`namesBead`, lib/reap.js), and it is what the incident report used by hand.
   * Two guards, not one, and they cover each other's gap: `candidates` filters the
   * workers this advocate remembers opening, which catches a session too young to have
   * renamed itself, and this catches the session it has forgotten.
   *
   * Every live session on the laptop, not just this workspace's, because ids are
   * prefixed per workspace (`cl-`, `bc-`) so a match cannot cross one — and a window
   * working a climative bead from a directory that maps elsewhere is exactly the case a
   * workspace filter would miss.
   */
  function withoutLiveSessions(a, queue) {
    const alreadySaid = new Set((a.heldByLive || []).map((h) => h.id));
    a.heldByLive = [];
    if (o.holdLiveSessions === false || !queue.length || !a.liveSessions?.length) return queue;

    const workable = [];
    for (const bead of queue) {
      const hit = a.liveSessions.find((s) => namesBead(s.name, bead.id));
      if (!hit) {
        workable.push(bead);
        continue;
      }
      const why = sittingWhy(hit);
      a.heldByLive.push({ id: bead.id, why, pid: hit.pid, sessionId: hit.sessionId || null });
      // Once per bead per spell of being held, like the two filters above it: a window
      // left open overnight would otherwise be 2,880 identical lines.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
    }
    return workable;
  }

  /** What the window is doing, for the pill and the log line. */
  function sittingWhy(s) {
    const where = s.where ? ` in ${s.where}` : '';
    return s.status === 'busy'
      ? `a session is working it right now (pid ${s.pid}${where})`
      : `a session already has it open${where} — pid ${s.pid}${s.status ? `, ${s.status}` : ''}`;
  }

  /**
   * The bead whose files another session already has its hands on.
   *
   * bc-mp8c. lib/claims.js has been able to answer "is anyone on this file?" since
   * bc-q5c2, and until this the only thing that ever asked was scripts/claim-guard.sh, at
   * `PreToolUse` — one step too late to be cheap. That hook fires when the session already
   * exists, has been briefed, has read the tree and has a plan; its refusal costs a wasted
   * tool call by design, and the session that means it insists and proceeds. Correct for an
   * edit. Wrong for a *dispatch*, where the same fact is free to act on: not opening a
   * window costs nothing, and the bead comes back the moment the claim expires or its
   * worktree ships.
   *
   * No new state and no new lock — the point of the bead. lib/lease.js holds the bead
   * across Macs, `git worktree lock` holds the tree, lib/claims.js holds the file; this
   * reads the third one at a different moment. It is the same map, and it is in this
   * process, so the read is a walk over a few dozen records.
   *
   * ## Two strengths of evidence, and only one of them may hold
   *
   * A **declared** surface is a forecast somebody wrote on the bead (bc-42ow), and it
   * holds. A **guessed** one is lib/beadfiles.js having read the description and found
   * paths that exist on disk, and it does not hold unless `holdGuessedFiles` says so — it
   * goes on `filesBusy` and the bead is dispatched anyway. bc-hrno is that decision, and
   * the rule behind it is `withoutTwins`': evidence that is a resemblance must err toward
   * doing the work twice rather than not at all. lib/inflight.js errs the other way and
   * says why — its evidence is a branch with commits on it.
   *
   * ## Nothing here has to be released
   *
   * There is no timer and no cleanup, because the hold is not a record: it is recomputed
   * from `claims.list()` on every survey, and that call prunes what has expired (`TTL_MS`)
   * and what belongs to a worktree no longer on disk as it reads. So a session that ends,
   * a claim that ages out and a `ship` that removes the tree all release this without
   * knowing it exists — which is the same reason `withoutOpenPrs` needs no release when a
   * pull request merges.
   *
   * A register that will not answer holds nothing back, like every other filter here.
   */
  function withoutClaimedFiles(a, queue, kin = null) {
    const heldBefore = new Set((a.heldByClaim || []).map((h) => h.id));
    const busyBefore = new Set((a.filesBusy || []).map((h) => h.id));
    a.heldByClaim = [];
    a.filesBusy = [];
    if (o.holdClaimedFiles === false || !queue.length) return queue;

    let records = [];
    try {
      records = claims.list();
    } catch {
      // The register is a map in this process, so this is very nearly impossible — and it
      // still may not empty a queue. Same rule as the `bd` half of `withoutTwins`.
      return queue;
    }
    if (!records.length) return queue;

    const dirs = repoDirs(a);
    if (!dirs.length) return queue;

    const workable = [];
    for (const bead of queue) {
      // The checkout this bead would be worked in, and only that one: a path named in a
      // Climative bead exists in thirty of the forty repos and means the one it is about.
      // `bead.repo` is `placeFor`'s answer, already resolved at the top of the survey.
      const where = (bead.repo ? dirs.filter((d) => d.name === bead.repo) : dirs).map((d) => d.dir).filter(Boolean);
      // The whole row, not the queue entry: the surface is read out of the description and
      // the queue entry deliberately carries none. A bead `kin` has no row for keeps the
      // narrow entry, which yields a title-only guess rather than an error.
      const { files, source } = surfaceOf(kin?.get(bead.id) || bead, where);
      const hits = occupiedBy(files, where, records);
      if (!hits.length) {
        workable.push(bead);
        continue;
      }
      const why = busyWhy(hits, source);
      const entry = {
        id: bead.id,
        why,
        files: [...new Set(hits.map((h) => h.file))],
        branch: hits[0].branch || null,
        source,
      };
      if (source === 'declared' || o.holdGuessedFiles === true) {
        a.heldByClaim.push(entry);
        // Once per bead per spell of being held, like the five filters above it: a session
        // that spends the afternoon in one file would otherwise be hundreds of lines.
        if (!heldBefore.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
        continue;
      }
      a.filesBusy.push(entry);
      // Said out loud even though nothing was held, because this is the line that tells
      // you whether turning `holdGuessedFiles` on would help or would only park work.
      if (!busyBefore.has(bead.id)) {
        console.log(`[advocate] ${a.name}: ${bead.id} — ${why}; opening a window anyway (holdGuessedFiles is off)`);
      }
      workable.push(bead);
    }
    return workable;
  }

  /**
   * The beads nothing has decided — not a P0, and no P0 above them. bc-rfnr.7.
   *
   * The queue half of the gate; the refusal half is at the door in lib/session.js, and
   * neither is the other's backup — see lib/underp0.js for why endorsement's two layers
   * are the shape this copies.
   *
   * **First, before the queue is planned or batched**, unlike the six filters below it.
   * They run at the end because they are about contention — a window, a branch, a file,
   * another Mac — and a bead they hold is work that will happen later. This one is about
   * whether the bead is work at all, and everything between here and them would otherwise
   * act on it first: `plansFor` would let a planner file children under an orphan epic,
   * and `batchesFor` would fold an orphan into a batch and carry it in on another bead's
   * launch, through a door that never asks this question.
   *
   * **A queue emptied by this is not a clear one**, and `tickOne` counts it into `quiet`
   * for that reason: an advocate that reported "clear" here and went on to *propose* new
   * work would be filing fresh beads over a tracker whose existing ones it had just
   * silently refused — which is the precise failure this epic exists to end, wearing the
   * uniform of the fix.
   *
   * A graph that will not answer holds nothing back, like every other filter here, and
   * `hasP0Above` is where that is decided — an empty index has no roots and answers true.
   */
  async function withoutOrphans(a, queue) {
    const heldBefore = new Set((a.heldByNoP0 || []).map((h) => h.id));
    a.heldByNoP0 = [];
    if (!queue.length) return queue;

    let index;
    try {
      index = await bd.graph(a.workspace);
    } catch {
      // `Bd.graph` swallows its own failures and answers an empty shape, which is already
      // fail-open; this is the belt for anything it could not. Same rule as the `bd` half
      // of `withoutTwins`: a read that did not happen may not empty a queue.
      return queue;
    }

    const workable = [];
    for (const bead of queue) {
      if (hasP0Above(index, bead.id)) {
        workable.push(bead);
        continue;
      }
      const why = `${NO_P0_ABOVE} — adopt it under a P0 and it is workable, with no other change`;
      a.heldByNoP0.push({ id: bead.id, why });
      // Once per bead per spell of being held, like the six filters below it — an orphan
      // sits in `bd ready` indefinitely and would otherwise be a line every thirty
      // seconds for as long as the daemon runs. The bus event goes with it rather than on
      // its own: it is the same news, and one repeated every tick would wake every parked
      // poller on the strength of nothing having changed.
      if (!heldBefore.has(bead.id)) {
        console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
        emit(a, 'noP0', { id: bead.id, why });
      }
    }
    return workable;
  }

  /**
   * Re-read the session records, and say whether that stops a launch.
   *
   * The same argument as the forced `inflight` read beside it — being ten minutes late
   * costs a whole window — and none of the cost: these are files on this laptop, so
   * there is no interval to throttle and no `gh` to time out. What moves inside a tick
   * is a session that has just renamed itself: a window opened seconds ago carries no
   * bead id until its first turn runs, and until then only `a.workers` knows about it.
   *
   * Returns whether a bead about to get a window now has one, so the caller re-surveys
   * only in the case that changes the answer. `survey` stays the one place `heldByLive`
   * is written, which is what keeps the card and the launch agreeing.
   */
  function resight(a, ready) {
    if (o.holdLiveSessions === false) return false;
    a.liveSessions = liveSessions(cfg);
    return ready.some((b) => a.liveSessions.some((s) => namesBead(s.name, b.id)));
  }

  /**
   * The bead whose work is already on a branch, held rather than launched again.
   *
   * The last subtraction from `bd ready`, after the hierarchy filter and the twins, and
   * the one with the hardest evidence behind it: not a title that reads alike, but an
   * open pull request that names this bead. lib/inflight.js holds the whole argument —
   * including why this one errs toward holding where `withoutTwins` errs toward working.
   *
   * It reads `a.openPrs`, which `inflight` below refreshes on an interval, and it does
   * **not** ask GitHub itself. That separation is deliberate: the survey runs up to three
   * times in a tick — once at the top, once after the landed sweep closes something, once
   * after the forced read before a launch — and a `gh pr list` inside it would be three
   * calls per repo per tick for an answer that moves when somebody opens or merges
   * something. An empty map holds nothing, which is what a repo with no GitHub remote and
   * a daemon that has not read yet both look like.
   */
  function withoutOpenPrs(a, queue) {
    const alreadySaid = new Set((a.heldByPr || []).map((h) => h.id));
    a.heldByPr = [];
    if (!queue.length || !a.openPrs?.size) return queue;

    const workable = [];
    for (const bead of queue) {
      const hit = a.openPrs.get(bead.id);
      if (!hit) {
        workable.push(bead);
        continue;
      }
      // The repo joins the sentence rather than only the pill: with forty checkouts
      // behind one workspace, "#12 already carries this work" names a number that
      // exists in every one of them.
      const why = hit.repo ? `${inflightWhy(hit)} — in ${hit.repo}` : inflightWhy(hit);
      a.heldByPr.push({ id: bead.id, why, number: hit.number, url: hit.url, repo: hit.repo || null });
      // Once per bead per spell of being held, like the twin filter: a pull request open
      // for a day would otherwise be 2,880 identical lines, and the card is where the
      // standing state belongs.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
    }
    return workable;
  }

  /**
   * Ask GitHub which pull requests are open, and which beads they carry.
   *
   * The same shape as `landed` below it and for the same reasons — throttled, forced
   * before a launch, and unable to take the tick down with it — with one difference that
   * matters: this one **writes nothing anywhere**. It reads, and what it produces is a
   * map the next survey filters against.
   *
   * Returns whether the held set changed, because the caller's queue was built from a
   * survey taken before this ran and is now wrong by exactly those beads.
   *
   * A read that fails keeps the previous map rather than clearing it. That is the safe
   * direction here: an empty map holds nothing back, so a `gh` that times out once would
   * hand a window to the very bead this exists to hold — and the map it is replacing was
   * true minutes ago, which is a better answer than none.
   */
  async function inflight(a, { force = false } = {}) {
    if (o.holdOpenPrs === false || cfg.pr?.enabled === false) return false;
    const due = force || minsSince(a.lastInflightAt) >= clampInt(o.inflightIntervalMinutes, 1, 24 * 60, DEFAULTS.inflightIntervalMinutes);
    if (!due) return false;

    // Every checkout, not the workspace's default one: a Climative bead's pull request
    // is open in the repo the bead is about, and a sweep that only ever asked
    // `architecture` would hold nothing back and say so in the same breath. See
    // `repoDirs`.
    const dirs = repoDirs(a);
    if (!dirs.length) return false;

    a.lastInflightAt = iso();
    const before = new Set([...(a.openPrs?.keys() || [])]);
    const beads = new Map();
    let checked = 0;
    let ok = false;
    const refused = [];
    for (const repo of dirs) {
      let result;
      try {
        result = await openWorkFor(a, repo.dir);
      } catch (err) {
        // One repo that will not answer is not the sweep failing: the other thirty-nine
        // still have pull requests open in them, and holding nothing back on their
        // account would be the exact failure this sweep exists to prevent.
        refused.push(`${inWhich(repo)}${err.message.split('\n')[0]}`);
        continue;
      }
      if (!result.ok) {
        refused.push(`${inWhich(repo)}${result.reason || 'the open-PR check was skipped'}`);
        continue;
      }
      ok = true;
      checked += result.checked;
      for (const [id, hit] of result.beads) {
        // First repo wins, in the order the approved list is written — the same rule
        // `openWork` keeps between two pull requests on one bead, for the same reason:
        // one sentence has to be chosen and the earliest is the one that has waited.
        if (beads.has(id)) continue;
        beads.set(id, repo.name ? { ...hit, repo: repo.name } : hit);
      }
    }

    if (!ok) {
      // Nothing could be read anywhere, so the previous map stands: an empty one holds
      // nothing back, and would hand a window to the very bead this exists to hold.
      const why = refused[0] || 'no checkout answered';
      // `describeInflight` and not a string spelled out here: the sentence a skipped
      // read produces belongs to lib/inflight.js, and two copies of it drift.
      a.inflight = {
        summary: describeInflight({ ok: false, reason: why }),
        held: a.openPrs?.size || 0,
        at: a.lastInflightAt,
        reason: why,
      };
      if (refused.length) console.error(`[advocate] ${a.name}: open-PR check failed — ${why}`);
      return false;
    }

    a.openPrs = beads;
    a.inflight = {
      // A repo that refused while others answered is a partial read, and it has to say
      // so: the beads whose pull requests live in *that* checkout are unheld right now,
      // and a blank summary over that state reads as "nothing is in flight".
      summary: refused.length ? `${refused.length} of ${dirs.length} checkouts did not answer — ${refused[0]}` : '',
      held: beads.size,
      checked,
      repos: dirs.length,
      at: a.lastInflightAt,
    };
    const after = new Set([...beads.keys()]);
    if (before.size !== after.size) return true;
    for (const id of after) if (!before.has(id)) return true;
    return false;
  }

  /** The read itself, injectable so a test can drive the filter without a `gh` on PATH. */
  const openWorkFor = (a, dir) => prs(bd, a.workspace, dir);

  /**
   * The other bead that is the same job, held rather than launched beside it.
   *
   * bc-9frx closed the proposal path: a proposed bead that matches an open one is
   * flagged on the card, and one nobody was shown is refused at the point of approval.
   * It left this road open. Two beads with the same title need no proposal to exist —
   * filed by hand, brought in by `bd jira pull`, or created by an approval that *was*
   * flagged and that you tapped anyway, which lib/server.js honours on purpose. Both
   * are ready, so both used to get a window, and the second session's first act is to
   * find the work already committed on the first one's branch. Same cost as bc-9frx,
   * reached without ever passing the check that was built for it.
   *
   * Three ways for the same job to be under way already, and the queue can see two of
   * them for free:
   *
   * 1. **Another bead in this tick's queue.** `queue` arrives in pick order, so the
   *    one that survives is the one that would have been launched first anyway — and
   *    the comparison is against what has survived, not against the raw list, so three
   *    copies collapse to one rather than to none.
   * 2. **A session this advocate already opened.** `a.workers` carries the title it
   *    was launched with, so this half costs nothing and covers the tick *after* the
   *    first window opened, which is the shape the incident actually took.
   * 3. **A bead somebody else claimed.** In progress and therefore out of `bd ready`
   *    entirely: a window opened by hand, by the launcher, or by a discuss session.
   *    This is the only half that costs a `bd` call, and it is asked once per survey
   *    and only when there is a queue for the answer to change.
   *
   * `findDuplicate` is bc-9frx's own comparison at bc-9frx's own threshold — near
   * verbatim and nothing looser, chosen off a real pair of opposite beads that share
   * six of seven words. Holding one bead over another is the sort of thing that must
   * err toward doing the work twice rather than not at all, so nothing here is
   * looser than the check that already refuses an approval.
   *
   * And a tracker that will not answer holds nothing back: the two free halves still
   * run, exactly as `heldByChildren` keeps a bead when `bd` cannot say.
   */
  async function withoutTwins(a, queue) {
    // What was held on the last tick, so a bead held for an hour costs one line in the
    // log rather than one hundred and twenty. The card is where the standing state
    // lives; the log is for the moment it changed.
    const alreadySaid = new Set((a.heldByTwin || []).map((h) => h.id));
    a.heldByTwin = [];
    if (!queue.length) return queue;

    const working = [];
    for (const w of a.workers) if (w.title) working.push({ id: w.id, title: w.title, status: 'working' });
    try {
      const rows = (await bd.listStatus(a.workspace, 'in_progress')) || [];
      for (const r of rows) {
        if (!r || !r.title || working.some((w) => w.id === r.id)) continue;
        working.push({ id: r.id, title: r.title, status: 'in_progress' });
      }
    } catch {
      // Cannot tell, which is not the same as "nothing is under way" — so this half
      // simply does not run and the two free ones still do. Silent for the same reason
      // `heldByChildren` is: nothing was held, so there is no cap to be loud about, and
      // a tracker mid-write must not print once every thirty seconds forever.
    }

    const workable = [];
    for (const bead of queue) {
      // Against `workable` and not `queue`: a bead is never its own twin, and the
      // second copy of three must not be judged against the first *and* hold the third.
      const ahead = workable.map((b) => ({ id: b.id, title: b.title, status: 'queued' }));
      // Hierarchy is `heldByChildren`'s business, and the two rules must not disagree:
      // a subtask often restates its parent's title almost word for word, and holding
      // `bc-3zo9.1` because a session is on `bc-3zo9` would be the exact opposite of
      // what that filter decided — an epic is not the work, its children are.
      const rows = [...working, ...ahead].filter(
        (r) => !isDescendantOf(r.id, bead.id) && !isDescendantOf(bead.id, r.id)
      );
      const hit = findDuplicate(bead.title, rows, { ignore: [bead.id] });
      if (!hit) {
        workable.push(bead);
        continue;
      }
      const why = twinNote(hit);
      a.heldByTwin.push({ id: bead.id, why });
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
    }
    return workable;
  }

  const twinNote = (hit) =>
    hit.status === 'working'
      ? `a session is already working ${hit.id}, which is the same job`
      : hit.status === 'queued'
        ? `${hit.id} is the same job, and is ahead of it in the queue`
        : `${hit.id} is the same job, and is already in progress`;

  /**
   * Why this bead is its children's work rather than its own — or null, meaning it is
   * work in its own right.
   *
   * The incident: one tick opened a session on the epic bc-3zo9 and, 1.3 seconds
   * later, a second on bc-3zo9.1, the epic's first child. Both were briefed to write
   * the same feature, and the epic session's only honest move was to write nothing —
   * its brief is the union of its children, and a live sibling already held the first
   * one. The more expensive of the two windows was the wasted one.
   *
   * Three checks, cheapest first, and each is a different way for the same thing to be
   * true:
   *
   * 1. **A child is in this queue too.** The narrow case, and the one that does not
   *    care what the parent is typed as: a parent and its child must never be launched
   *    in the same tick, epic or not.
   * 2. **A session is already working a child — or a parent.** The same fact one tick
   *    later, and since bc-zgfo asked both ways up. Without the downward half the parent
   *    would simply be picked up on the tick after the child was, which is the incident
   *    with a pause in the middle; without the upward half a child that goes ready
   *    *after* its parent's window opened takes a second window inside that subtree.
   * 3. **It is an epic with an open child**, wherever that child is — in_progress,
   *    blocked, deferred, or filtered out of the queue by the priority floor. This is
   *    the only one that costs a `bd` call, and only for epics that survived the first
   *    two, because an epic *is* its children until they are done.
   *
   * Note what is deliberately still workable: a leaf epic, and an epic whose children
   * are all closed. Dropping every epic outright would have been one line, but an epic
   * with nothing under it is an ordinary bead with an ambitious type, and there is no
   * reason it should need a human to retype it before anything will pick it up. That
   * allowance is also what makes check 2's upward half load-bearing rather than
   * theoretical: such an epic launches, and the first bead filed under it while its window
   * runs would otherwise be ready work with a live session already inside its subtree.
   *
   * A `bd` that will not answer means "cannot tell", and cannot-tell keeps the bead:
   * a tracker mid-write must not be able to empty an advocate's queue.
   */
  /**
   * What the epics that have been *planned* want done this tick.
   *
   * The third answer to the same problem `heldByChildren` and `batchesFor` answer, and the
   * only one that is not a rule this file made up. Those two decide what to do with an
   * epic's children from the ids alone — hold them, or fold them into one window. This one
   * reads what an **epic worker** decided about them (lib/plan.js) and does that instead:
   * one child-worker per group, each briefed on the group's beads and on the paragraph the
   * planner wrote for it. A judgement outranks a heuristic wherever there is one.
   *
   * Returns everything the survey needs to place a bead, and nothing it does not:
   *
   *   - `planned`     epic ids that carry a live plan. `batchesFor` skips these subtrees
   *                   entirely, which is the whole of "the two never run on one subtree at
   *                   once" — there is one set, computed here, and the mechanical grouping
   *                   consults it before it considers an epic at all.
   *   - `groupOf`     lead bead id → the group that window carries. The lead is recomputed
   *                   every tick by `dispatchable`, so a group whose window ended picks its
   *                   remaining work back up on the next one.
   *   - `plannedInto` every other ready bead of a dispatched group → its lead, so one group
   *                   is one window rather than one window per bead in it.
   *   - `awaiting`    ready beads under a planned epic that **no group names** → that epic.
   *                   These are what a re-entry is for; see below.
   *   - `plannerOf`   epic id → the ungrouped beads it is being re-opened to plan.
   *   - `epicHold`    epic id → why the epic itself is not work. A planned epic is never
   *                   worked: its groups are the work, and when they are done what is left
   *                   is a promotion rather than a window.
   *   - `promotable`  planned epics whose every named bead has closed, with their plans —
   *                   what `promote` files a promotion bead against.
   *
   * ## Re-entry, which is the substance of bc-jk4m
   *
   * A supervisor that watched an epic from planning through merge and release would be a
   * window measured in days, holding a worker slot against a `workerTimeoutMinutes` of 120
   * and forgetting everything if the daemon restarted. So there is no such window. The plan
   * is a document on the bead, every tick reads it, and a planner is re-opened only when
   * there is something new to plan — which is exactly one event: **a ready bead under the
   * epic that no group names.** In practice that is a bead a child-worker filed with
   * bin/file.js and Adam has since endorsed, arriving under an epic planned before it
   * existed. Everything else needs no supervision at all: a group finishing simply means
   * the next tick dispatches the next group, because none of this is remembered between
   * ticks in the first place.
   *
   * The ungrouped beads are held while that planner runs, so nothing opens a window on a
   * bead that is about to be told which group it is in — **but only while a planner can
   * still be opened.** Once the epic has used up `maxAttemptsPerBead`, holding them would
   * be a queue that never drains behind a window that will never open again, so they are
   * released and dispatched on their own, one window each. That is the same fallback the
   * whole feature has: when planning cannot happen, the work still gets done the old way.
   *
   * ## What a label without a plan does
   *
   * Nothing. `readPlan` returns null and the epic falls through to `batchesFor` exactly as
   * an unplanned one would. bin/plan.js writes the comment before the label so that state
   * should not arise, and it is harmless when it does — which is the right direction for a
   * marker that is only ever a way to *avoid* a read.
   */
  async function plansFor(a, queue, labels) {
    const groupOf = new Map();
    const plannedInto = new Map();
    const awaiting = new Map();
    const plannerOf = new Map();
    const epicHold = new Map();
    const planned = new Set();
    const promotable = [];
    const out = { planned, groupOf, plannedInto, awaiting, plannerOf, epicHold, promotable };
    if (o.planEpics === false) return out;

    const maxAttempts = clampInt(o.maxAttemptsPerBead, 1, 10, DEFAULTS.maxAttemptsPerBead);
    const depth = (id) => String(id).split('.').length;
    // Shallowest first, for `batchesFor`'s reason: the outermost planned epic in a nest is
    // the one whose plan speaks, and an inner one is then skipped rather than dispatching a
    // second set of groups over beads the outer plan already named.
    const epics = queue.filter((b) => b.type === 'epic').sort((x, y) => depth(x.id) - depth(y.id));

    for (const epic of epics) {
      if (!(labels.get(epic.id) || []).some((l) => String(l).trim() === PLANNED_LABEL)) continue;
      const outer = [...planned].find((p) => isDescendantOf(epic.id, p));
      if (outer) {
        epicHold.set(epic.id, `${outer}'s plan already speaks for this subtree`);
        continue;
      }
      const plan = await readPlan(bd, a.workspace, epic.id);
      if (!plan) continue;
      planned.add(epic.id);

      const { groupOf: groups, plannedInto: members, done } = dispatchable(plan, {
        queue,
        workers: a.workers,
      });

      // Ready under this epic and in no group — and not something a group is already
      // speaking for, which `unplanned` cannot know about because it only reads the plan.
      const loose = unplanned(plan, queue).filter((b) => !groups.has(b.id) && !members.has(b.id));
      const canPlan = (a.attempts[epic.id] || 0) < maxAttempts;
      if (loose.length && canPlan) {
        // Re-entry, and **nothing else under this epic moves while it happens**. Dispatching
        // a group against a plan that is being rewritten is a window briefed on a version of
        // the plan that will not exist by the time it reads its first file; and holding only
        // the *ungrouped* beads would leave the members of an undispatched group looking like
        // ordinary ready work, which is one window per bead — the thing the plan replaced.
        // Groups already open are untouched: they have their own windows, and the planner is
        // told to leave the groups that are under way alone.
        plannerOf.set(epic.id, loose);
        for (const b of queue) if (isDescendantOf(b.id, epic.id)) awaiting.set(b.id, epic.id);
        continue;
      }

      for (const [lead, group] of groups) groupOf.set(lead, group);
      for (const [id, lead] of members) plannedInto.set(id, lead);

      if (done && !loose.length) {
        promotable.push({ epic: { ...epic, labels: labels.get(epic.id) || [] }, plan });
        epicHold.set(epic.id, 'every bead in its plan is closed — a promotion bead carries what is left');
        continue;
      }
      const live = groupOf.size + plannedInto.size;
      epicHold.set(
        epic.id,
        live ? `its plan is being worked in groups` : `its plan is written; nothing under it is ready`
      );
    }
    return out;
  }

  /**
   * File the promotion bead for every planned epic whose work has all landed.
   *
   * Separate from the survey that found them because the survey only ever *reads* — it runs
   * twice in a tick when `landed` moved something, and a `bd create` inside it would be two
   * beads for one epic. See lib/promote.js for what makes filing safe unattended, and for
   * why this is not the same thing as lib/release.js's per-merge `ship` bead.
   */
  async function promote(a) {
    if (o.filePromotions === false || OBSERVING) return;
    for (const { epic, plan } of a.promotable || []) {
      const r = await filePromotion(bd, a.workspace, epic, plan);
      if (r.already) continue;
      if (r.skipped) {
        console.error(`[advocate] ${a.name}: ${r.skipped}`);
        continue;
      }
      if (r.warn) console.error(`[advocate] ${a.name}: ${r.warn}`);
      console.log(`[advocate] ${a.name}: ${epic.id}'s work is in main — filed ${r.filed} to promote it`);
      emit(a, 'promoted', { id: epic.id, title: epic.title, detail: `promotion bead ${r.filed}` });
    }
  }

  /**
   * Which epics carry their own ready children this tick, and which beads that folds up.
   *
   * `heldByChildren` and this are two answers to one problem. That one suppresses the
   * parent so the children get worked one window at a time; this one dispatches the
   * parent *carrying* the children, so a single worker sees the whole subtree and can
   * decide what belongs in which phase. The suppression was never wrong — it stopped the
   * bc-3zo9 duplicate — it just spends a window per child and gives no worker a view
   * wide enough to sequence them.
   *
   * **Since bc-jk4m this is the fallback rather than the answer.** Where an epic worker has
   * planned an epic (lib/plan.js), `plansFor` dispatches that plan's groups and this does
   * not consider the subtree at all — that is what the `planned` argument is, and it is the
   * whole of "a plan and a batch never run on one subtree at once": one set, computed once,
   * consulted before an epic is even a candidate. Where nothing has been planned, this
   * still runs exactly as bc-bhp9 wrote it, because a mechanical grouping is worse than a
   * considered one and much better than none.
   *
   * And where an epic *could* be planned, the same candidate test now produces a **planner**
   * instead of a batch head — same three conditions, same floor, same subtree guards, so
   * the two can never disagree about which epics they are talking about. The one place they
   * come apart is on the way back: an epic whose planning has failed `maxAttemptsPerBead`
   * times falls through to a batch, because a window that will not open again must not be
   * the reason its children are held forever.
   *
   * Returns `{ batchOf, plannerOf, foldedInto }`:
   *   - `batchOf`   epic id → the children that go in its brief, in pick order.
   *   - `plannerOf` epic id → its ready children, for an epic that will be planned rather
   *     than batched. Every one of them is in `foldedInto` too: they are held while the
   *     planner decides which group each belongs to, exactly as a batch's are.
   *   - `foldedInto` bead id → the epic that now speaks for it, for every ready
   *     descendant of a batch head. That is deliberately wider than `batchOf`: a child
   *     the cap pushed out of the brief still must not get its own window, or the batch
   *     and the leftover would be two sessions in one subtree, which is the incident
   *     again with extra steps. It waits for a later tick instead.
   *
   * Three conditions, and each is the batch's version of a suppression rule:
   *
   * 1. **It is an epic with ready children in the queue.** A plain task with children
   *     keeps the old behaviour — `heldByChildren`'s narrow half does not care about
   *     types, and neither does this, so an untyped parent is still held rather than
   *     turned into a batch head.
   * 2. **No live session already holds anything in the subtree.** `a.workers` keyed by
   *     bead id plus `isDescendantOf` is the whole test, and it is the same one the
   *     suppression uses — two windows must never hold one subtree, batch or not.
   * 3. **Every open child is one this queue can see.** The `bd` call the epic branch of
   *     `heldByChildren` already pays for, asked for the same reason: a child that is
   *     in_progress, blocked or under the priority floor is work this tick knows nothing
   *     about, and briefing a batch over it is how a batch worker ends up writing on top
   *     of a session already doing that child. Cannot-tell keeps the old suppression,
   *     for the same reason cannot-tell keeps a bead.
   *
   * Shallowest epic first, so the outermost epic in a nest is the one that carries the
   * subtree rather than whichever of them the pick order happened to reach first — and
   * `foldedInto` then stops the inner epic being its own batch head underneath it.
   */
  async function batchesFor(a, queue, planned = new Set()) {
    const batchOf = new Map();
    const plannerOf = new Map();
    const foldedInto = new Map();
    const maxAttempts = clampInt(o.maxAttemptsPerBead, 1, 10, DEFAULTS.maxAttemptsPerBead);
    if (o.batchEpicChildren === false) return { batchOf, plannerOf, foldedInto };
    const cap = clampInt(o.maxBatchBeads, 1, 25, DEFAULTS.maxBatchBeads);
    const floor = Math.min(clampInt(o.minBatchBeads, 1, 25, DEFAULTS.minBatchBeads), cap);
    const depth = (id) => String(id).split('.').length;
    const epics = queue.filter((b) => b.type === 'epic').sort((x, y) => depth(x.id) - depth(y.id));
    // Built once for the whole pass rather than per epic: it is a fact about this tick's
    // queue, and an advocate ticks every thirty seconds for the life of the daemon.
    const seen = new Set(queue.map((b) => b.id));

    for (const epic of epics) {
      if (foldedInto.has(epic.id)) continue;
      // Somebody has already decided about this subtree, and it was not a heuristic. Both
      // directions, for the reason the worker check below is both directions: an inner epic
      // under a planned one would otherwise become a batch head *inside* a plan, which is
      // two dispatchers on one subtree — the exact thing the plan is meant to replace.
      if (planned.has(epic.id) || [...planned].some((p) => isDescendantOf(epic.id, p))) continue;
      // A window already inside this subtree, either way up. The downward half is the
      // suppression's own second check. The upward half has to be asked *here* rather than
      // left to `heldByChildren`, because a batch head goes straight onto the workable list
      // — that is what makes it one — and so never reaches the suppression at all: an inner
      // epic under a live batch would be promoted to a batch head of its own, and the two
      // windows would hold overlapping subtrees. Unqualified since bc-zgfo, and it has to
      // stay in step with `heldByChildren`'s upward check to the letter: the two rules
      // disagreeing is an epic this suppresses and that promotes, or the reverse, and
      // either way one subtree gets two answers on one tick. See the note there for why
      // the batch-head qualifier came off.
      if (a.workers.some((w) => isDescendantOf(w.id, epic.id))) continue;
      if (a.workers.some((w) => isDescendantOf(epic.id, w.id))) continue;
      // Same checkout only. Since bc-l853.4 a bead names its repo (`repo:` label →
      // `bead.repo`), and one window opens in exactly one of them — the epic's. A child
      // living in another repo briefed into this batch would be worked in the wrong tree,
      // so it is left out and takes its own window in its own checkout later; the ancestor
      // guard holds it while the batch runs, which costs it a wait and not a mistake. Both
      // null in a single-repo workspace, which is every workspace that has not opted in.
      const kids = queue.filter(
        (other) => isDescendantOf(other.id, epic.id) && !foldedInto.has(other.id) && (other.repo ?? null) === (epic.repo ?? null)
      );
      // Below the floor this epic is not a batch head at all, and it must fall through to
      // `heldByChildren` untouched rather than becoming a batch of one. See `minBatchBeads`.
      if (kids.length < floor) continue;

      let children;
      try {
        children = await bd.children(a.workspace, epic.id);
      } catch {
        continue;
      }
      // Every open child has to be one this queue can already see. `bd.children` returns
      // direct children only, so this reaches one level: a *grandchild* that is in_progress
      // with no live worker on it — a stale claim, or one you took yourself — is not caught
      // here. What does catch it is the worker check above, which is by subtree rather than
      // by level, so the case left uncovered is specifically "claimed but nothing running".
      // Recursing would be a `bd` call per level per epic per tick to close a gap that a
      // reclaim already closes, which is the wrong trade on a thirty-second tick.
      const open = (children || []).filter((c) => c && c.status !== 'closed');
      if (open.some((c) => !seen.has(c.id))) continue;

      // Plan it rather than batch it, where planning is on and this epic has not already
      // burned its attempts trying. The children are folded either way — held while one
      // window decides what to do with them — so the only difference between the two
      // branches is which brief that window gets, which is exactly what bc-jk4m changes.
      //
      // The cap is deliberately not applied to a planner. `maxBatchBeads` bounds a brief
      // that says "do all of these"; a planner's list says "these are what there is to
      // group", and a planner shown five of twelve children would write a plan that is
      // wrong about the epic rather than merely partial.
      if (o.planEpics !== false && (a.attempts[epic.id] || 0) < maxAttempts) {
        plannerOf.set(epic.id, kids);
        for (const kid of kids) foldedInto.set(kid.id, epic.id);
        continue;
      }
      batchOf.set(epic.id, kids.slice(0, cap));
      for (const kid of kids) foldedInto.set(kid.id, epic.id);
    }
    return { batchOf, plannerOf, foldedInto };
  }

  async function heldByChildren(a, bead, queue) {
    const child = queue.find((other) => isDescendantOf(other.id, bead.id));
    if (child) return `${child.id} is ready under it`;

    const worked = a.workers.find((w) => isDescendantOf(w.id, bead.id));
    if (worked) return `a session is working ${worked.id} under it`;

    // And the same question the other way up. **Any** live worker above this bead, since
    // bc-zgfo; it used to be batch heads only, and the qualifier coming off is the change.
    //
    // A batch head claims its epic, so the epic leaves `bd ready` while its children are
    // still in it, and every check above asks only about work *underneath* a bead. Without
    // this the batch's own siblings came back as individually launchable on the very next
    // tick: one window writing the subtree and N more opened inside it — the bc-3zo9
    // incident recreated by the fix for it.
    //
    // `w.batch.length` was the qualifier because a worker handed the subtree owns it and a
    // worker handed one bead owns one bead — an epic is not the work, its children are, and
    // holding a child because something sits on its parent looked like leaving nobody doing
    // either. That reasoning has one hole and bc-zgfo is it: **a hold behind a live window
    // is a wait, not a stall.** The worker above ends, `reconcile` drops it, and the child
    // launches on the next tick — bounded by `workerTimeoutMinutes` in the worst case,
    // where the unqualified duplicate it prevents is two sessions writing one subtree with
    // the parent's brief a superset of the child's, which is bc-3zo9 with the order
    // reversed and costs a branch rather than a wait.
    //
    // Two ways in, and neither needs a batch to reach. A **non-epic parent** whose only
    // child was blocked when it launched and unblocks an hour later: the parent's window is
    // live, has no batch, and nothing held the child. And an **epic that launched with no
    // open children** — which is exactly what `heldByChildren`'s own closing paragraph
    // declares workable — and then gains one, which is what an agent filing a bead under
    // the epic it is working does. bc-2uj4 was itself in the second state while this was
    // written.
    //
    // The floor is unchanged where it matters: with no workers there is nothing to find,
    // and a worker on a bead with no descendants in the queue matches nothing. What this
    // costs is one array scan per held bead per tick over a list capped at `maxWorkers`.
    const above = a.workers.find((w) => isDescendantOf(bead.id, w.id));
    if (above) return `a session is working ${above.id} above it`;

    if (bead.type !== 'epic') return null;
    let children;
    try {
      children = await bd.children(a.workspace, bead.id);
    } catch {
      return null;
    }
    const open = (children || []).filter((c) => c && c.status !== 'closed');
    if (!open.length) return null;
    return `an epic with ${open.length} open child ${open.length === 1 ? 'issue' : 'issues'}`;
  }

  /* ---------------------------------------------------------- reconciliation */

  /**
   * Which launched sessions are still worth a slot.
   *
   * There is no process to watch — the window belongs to iTerm, not to us — so the
   * bead is the evidence. Closed means done. Still open and never claimed, with
   * nothing running in that repo, means the window was shut on it: that frees the
   * slot and costs the bead an attempt, because retrying forever is how an advocate
   * turns into a machine for reopening the same window.
   */
  async function reconcile(a, sessions) {
    if (!a.workers.length) return;
    const kept = [];
    // One tracker call for the whole pass, shared by every worker that needs it. It used
    // to be one per *ended* worker, which was at most a handful a day; now a worker whose
    // window is merely idle asks too, and that is a question about every quiet window on
    // every tick. `listLabel` returns the workspace's open delivery cards whoever asks,
    // so there was never anything per-worker about the call itself. See `deliveryFor`.
    const deliveries = {};
    // One per pass, for the same reason `deliveries` is: two workers under one epic ask the
    // same question of the same ancestor, and `leaseHolderAbove` is a `bd show` when the
    // answer is not already in hand. See bc-etbq.
    const aboveCache = new Map();
    for (const w of a.workers) {
      let issue = null;
      try {
        issue = await bd.show(a.workspace, w.id);
      } catch (err) {
        // A workspace mid-write must not retire a live session. Keep it; the next
        // tick asks again.
        kept.push(w);
        continue;
      }

      // `namesBead` rather than a substring: a bead's subtasks are `<id>.1`, `<id>.2`,
      // so every parent id is a prefix of its children's and `includes` would join a
      // worker to a window working a different bead. See lib/reap.js.
      const mine = sessions.find((s) => namesBead(s.name, w.id));
      // Captured while it is alive and never overwritten with null: once the process
      // is gone this id is the only route back to what it did.
      if (mine?.sessionId) w.sessionId = mine.sessionId;
      w.pid = mine?.pid || null;
      w.sessionStatus = mine?.status || null;
      w.claimed = issue?.status === 'in_progress';
      // The session's own word for it, where it got to leave one.
      const ended = readDone(a.name, w.id);
      w.ended = Boolean(ended);

      if (!issue) {
        finish(a, w, 'the bead is gone');
        continue;
      }
      if (issue.status === 'closed') {
        delete a.attempts[w.id];
        /**
         * Closed how, though. `Landed as #42 as abc1234` is the close reason
         * bin/deliver.js writes when a worker merged its own pull request, and it is
         * worth pulling out: on the sessions page every ended worker otherwise reads
         * "closed by the session", which is the one sentence that does not say whether
         * the work reached `main`. A session can close a bead over a commit nobody will
         * ever merge; this one demonstrably did not.
         *
         * Read off the close reason rather than asked of GitHub, because it costs
         * nothing — `bd show` has already returned — and because the alternative is a
         * `gh` call per ended worker per tick to re-derive something the delivery
         * already knew.
         */
        const why = String(issue.close_reason || '');
        const landedBy = (why.match(/\bLanded as (#\d+)/) || [])[1];
        // And the other way work reaches main, which reads identically from here and is
        // not the same story at all: `Merged #42 … on GitHub` is what lib/landed.js
        // writes when a pull request was merged on github.com and this closed the bead
        // afterwards. Crediting that to the session would be crediting it with a merge
        // it did not make — and on the sessions page it is the more interesting of the
        // two, because it means the window was working something already landed.
        const sweptBy = (why.match(/\bMerged (#\d+)\b.*\bon GitHub\b/) || [])[1];
        finish(
          a,
          w,
          landedBy
            ? `landed ${landedBy} — the session merged its own pull request${ended ? ' and exited' : ''}`
            : sweptBy
              ? `${sweptBy} was merged on GitHub — closed by the sweep, not by the session`
              : ended
                ? 'closed by the session, which then exited'
                : 'closed by the session',
          'done'
        );
        continue;
      }
      /**
       * The two endings a session reaches *without exiting*.
       *
       * A worker that landed its own work closed its bead on the way out and was caught
       * above. These are the other two the brief documents, and both leave the bead open
       * on purpose: **delivered** — the merge was refused or the session asked for
       * review, so a pull request is waiting on a tap — and **handback** — it needs a
       * decision, so the question is on the bead under a `human` label. Neither is an
       * exit. `claude` is interactive; the session says its last word and the TUI goes
       * back to waiting.
       *
       * Which is why the test is `quiet` and not `ended`. Testing only for the done file
       * meant these two were recognised solely once *you* had closed the window, and
       * until you did, a delivered session held its slot for `workerTimeoutMinutes` and
       * was then written down as having timed out — charged an attempt for reaching an
       * ending the brief asked it to reach, and after two of those the advocate gives up
       * on a bead whose work is sitting in a pull request. It also meant an outcome in
       * `REAPABLE` could never name a window there was anything left to close.
       *
       * `idle` is the whole of "it has stopped talking" for a worker, and it is safe
       * because a worker's window holds exactly one turn — the brief — so the only
       * moment that turn is over is the moment the session is finished. Nothing is
       * signalled on the strength of this anyway: lib/reap.js re-reads the status, waits
       * out `closeGraceSeconds`, and checks the name again before anything is sent.
       */
      const quiet = Boolean(ended) || w.sessionStatus === 'idle';
      // Free: the labels came back with the bead.
      const handedBack = (issue.labels || []).includes('human');
      // Not free, so it is asked only of a session that has stopped, and at most once
      // per reconcile however many of them have.
      const delivered = quiet && !handedBack ? await deliveryFor(a, w.id, deliveries) : null;
      if (quiet && (delivered || handedBack)) {
        // Both are documented endings the brief asks for, so neither costs an attempt;
        // anything else does, or the same window reopens forever.
        delete a.attempts[w.id];
        finish(
          a,
          w,
          delivered
            ? `delivered as a pull request — waiting on ${delivered} for the merge`
            : 'handed back to you — it needs a decision',
          delivered ? 'delivered' : 'handback'
        );
        continue;
      }
      /**
       * And the ending nobody on *this* Mac chose: another machine claimed the same bead
       * inside the sync window, and the tiebreak went the other way.
       *
       * Placed here on purpose — after the three endings the session reached for itself,
       * before the three this advocate would otherwise impose. A window that closed its
       * bead, delivered a pull request or handed back a question has already done
       * something, and describing that as a stand-down would lose the only account of it.
       * A window still going has not, and every minute it keeps going is a minute of work
       * the other Mac is also doing. It matters most for `ended` directly below: a session
       * that exited having lost the bead would otherwise be written down as having exited
       * without closing it, and charged an attempt for a race it could not see.
       */
      if (leasing()) {
        const v = leaseVerdict(issue.labels || [], me, leaseOpts());
        if (v.lost) {
          await standDown(a, w, v.holder);
          continue;
        }
        /**
         * And the same ending one level up (bc-etbq): nobody else claimed *this* bead, but
         * another machine holds an epic above it, so its window is responsible for the
         * subtree this one is working inside.
         *
         * Both halves are needed and the queue filter alone is not enough, because the
         * race this closes happens *before* either machine has synced: Mac A takes the
         * epic, Mac B takes a child, and neither could see the other when it launched.
         * `withoutLeases` only helps whichever machine ticks next after the sync, and by
         * then B's window is already open — this is what closes it. The two rules agree
         * about who survives, because the asymmetry decides it: the machine above stands
         * nobody down, so exactly one window is left, which is the whole of what
         * `leaseVerdict`'s tiebreak promises.
         *
         * Asked of the ancestor chain and not of `issue`, so it costs one `bd show` per
         * ancestor of a worker whose bead has one — a worker on a top-level bead pays
         * nothing, and neither does an install with no `me`.
         */
        const up = await leaseHolderAbove(a, w.id, { cache: aboveCache });
        if (up) {
          await standDown(a, w, up.holder, { over: up.ancestor });
          continue;
        }
        // Won a contested one. Worth a line exactly once, and the reason is that the
        // loser's account of the race is on the *loser's* Mac: if that machine is asleep
        // — which is the likeliest way a stale claim got there — this is the only record
        // anywhere that two windows were opened on this bead.
        if (v.won && !w.contested) {
          w.contested = true;
          console.log(`[advocate] ${a.name}: ${w.id} was claimed by ${v.live.length} machines — this one holds it`);
        }
        // Ours, and getting old: restamp it so a session that runs longer than the lease
        // does not have the bead taken out from under it by the clock. Half-life, so one
        // missed tick costs nothing — see `renewDue`.
        if (renewDue(v.mine, leaseOpts())) {
          const fresh = await stake(a, w.id);
          if (fresh) {
            // The old one comes off only once the new one is written. The other order has
            // a window, however short, in which this bead is claimed by nobody — and a
            // window that small is exactly the width of the race this whole file is about.
            if (v.mine && v.mine.label !== fresh) await unstake(a, w.id, v.mine.label);
            w.lease = fresh;
          }
        }
      }
      if (ended) {
        // It exited, closed nothing, delivered nothing and asked nothing. That is the
        // one ending here nobody chose, and it costs an attempt.
        a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        finish(
          a,
          w,
          `the session exited without closing it${ended.code ? ` (exit ${ended.code})` : ''}`,
          'unfinished'
        );
        continue;
      }
      // Asked to check in, and still open: the answer is either sitting in a file or
      // it never came. Ordered after the endings above on purpose — a session that
      // answered by *finishing* is recorded as finished, not as silent.
      if (w.asked) {
        const said = readCheckin(a.name, w.id);
        if (answersCheckin(w.asked, said)) {
          w.asked = null;
          w.checkedInAt = said.at;
          w.checkinNote = said.note;
          clearCheckin(a.name, w.id);
          console.log(`[advocate] ${a.name}: ${w.id} checked in — ${said.note || 'still working'}`);
          emit(a, 'checked-in', { id: w.id, title: w.title, detail: said.note || 'still working on it' });
        } else if (minsSince(w.asked) > clampInt(o.checkinMinutes, 1, 240, DEFAULTS.checkinMinutes)) {
          // No answer and no exit. The slot goes back, and the bead is charged
          // nothing: silence is evidence about the *window*, not about the work, and
          // a bead that lost two slots to unanswered questions would be given up on
          // for something no session did wrong.
          finish(a, w, `asked to check in ${Math.round(minsSince(w.asked))}m ago and never answered`, 'silent');
          continue;
        }
      }
      if (minsSince(w.at) > clampInt(o.workerTimeoutMinutes, 5, 24 * 60, DEFAULTS.workerTimeoutMinutes)) {
        a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        finish(a, w, `still open after ${Math.round(minsSince(w.at) / 60)}h — releasing the slot`, 'timeout');
        continue;
      }
      // A window that never claimed anything and left no process behind: gone.
      const graceOver = minsSince(w.at) > clampInt(o.lapseMinutes, 1, 240, DEFAULTS.lapseMinutes);
      if (graceOver && !w.claimed && !mine && !sessions.length) {
        a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        finish(a, w, 'the session went away without claiming it', 'lapsed');
        continue;
      }
      kept.push(w);
    }
    a.workers = kept;

    // Whatever ended, this Mac is done with those beads — so its claim comes off rather
    // than being left to time out. It is the difference between the other machine picking
    // up a released bead on its next pull and picking it up in an hour. `standDown` has
    // already unstaked its own, which is why nothing here removes a label twice.
    if (leasing()) {
      for (const { worker } of a.finished) await unstake(a, worker.id, worker.lease);
    }
  }

  /**
   * The open delivery question for a bead, or null.
   *
   * Asked of the tracker rather than inferred from the bead's own status, because
   * "blocked" is derived in bd and a dependency on a question is not distinguishable
   * from any other dependency — and the id of the question is worth having anyway:
   * it is what the card says the slot is waiting on, which is the difference between
   * "delivered" and "delivered, and here is what to go and answer".
   *
   * One `bd` call, only ever for a session that has stopped talking — and, via `cache`,
   * only one for the whole reconcile pass however many of them have. The answer is the
   * workspace's open delivery cards, which is the same answer for every worker asking,
   * so the call was never per-bead; it only looked that way while the caller was rare.
   * A pass that fails to get it asks again for the next worker rather than caching the
   * failure: a tracker that will not answer is not evidence of anything, and least of
   * all evidence that nothing was delivered.
   *
   * Which card belongs to which bead is `cardsForDelivery`'s question and is asked
   * there rather than here — the same function bin/deliver.js uses to decide what a
   * new delivery supersedes. Two answers to "is this card about this bead" is how the
   * inbox and the advocate come to disagree about how many cards are open.
   */
  async function deliveryFor(a, beadId, cache = {}) {
    if (!('open' in cache)) {
      try {
        cache.open = await bd.listLabel(a.workspace, DELIVERY_LABEL);
      } catch {
        return null;
      }
    }
    return cardsForDelivery(cache.open || [], { bead: beadId })[0]?.id || null;
  }

  function finish(a, w, why, kind = 'ended') {
    // A session that has just ended is the one moment a worktree is most likely to
    // have become sweepable, so the next tick looks rather than waiting out the
    // interval.
    a.sweepDue = true;
    // Archived after the reconcile loop rather than here: this runs inside it, and
    // an archive is several git calls per session.
    a.finished.push({ worker: w, outcome: kind, why });
    console.log(`[advocate] ${a.name}: ${w.id} — ${why}`);
    clearActivity(`${a.name}/${w.id}`);
    clearDone(a.name, w.id);
    emit(a, kind, { id: w.id, title: w.title, detail: why });
    // A worker leaves the slot list here, so this is the last moment its pid is
    // known. If it reached one of its own endings — closed the bead, delivered, handed
    // it back — and is still running, the window is one of the ones that never closes.
    // Hand it to the reaper. See lib/reap.js.
    const closing = closingFor(w, kind, { enabled: o.closeFinishedSessions !== false });
    if (closing && !a.closing.some((c) => c.id === closing.id)) a.closing.push(closing);
  }

  /* ------------------------------------------------------------- closing windows */

  /**
   * Signal the sessions whose beads are closed and whose windows are still open.
   *
   * Run from the tick rather than from `finish`, because every guard in lib/reap.js is
   * about *time* — idle for long enough, not merely idle at the instant the bead was
   * seen closed — and a decision made once, inline, could only ever be the instant.
   * The list is persisted with the workers for the same reason they are: the windows
   * outlive the daemon, and a restart that forgot them would leave exactly the pile
   * this exists to clear.
   *
   * An observer instance signals nothing. It is a second daemon booted to watch a live
   * one, and `OBSERVING` means "change nothing on this Mac" — a signal is the least
   * observable act there is.
   */
  function reapClosing(a, sessions) {
    if (!a.closing.length) return;
    if (OBSERVING) return;
    const opts = {
      closeGraceSeconds: clampInt(o.closeGraceSeconds, 0, 3600, REAP_DEFAULTS.closeGraceSeconds),
      closeHardSeconds: clampInt(o.closeHardSeconds, 5, 3600, REAP_DEFAULTS.closeHardSeconds),
      closeGiveUpMinutes: clampInt(o.closeGiveUpMinutes, 1, 24 * 60, REAP_DEFAULTS.closeGiveUpMinutes),
    };
    const kept = [];
    for (const entry of a.closing) {
      const { act, why } = decide(entry, sessions.find((s) => s.pid === entry.pid), opts);
      if (act === 'wait') {
        kept.push(entry);
        continue;
      }
      if (act === 'drop') {
        // Only the endings that are *not* the ordinary one are worth a line: a window
        // that went away is what was asked for, and saying so once per closed bead
        // would double the advocate's log for no information.
        if (why !== 'the window is gone') console.log(`[advocate] ${a.name}: ${entry.id} — ${why}`);
        continue;
      }
      const sig = act === 'kill' ? 'SIGKILL' : 'SIGTERM';
      let delivered;
      try {
        delivered = signal(entry.pid, sig);
      } catch (err) {
        // EPERM, in practice: something else owns that pid. Stop rather than retry.
        console.error(`[advocate] ${a.name}: could not signal ${entry.id} (pid ${entry.pid}) — ${err.message}`);
        continue;
      }
      if (!delivered) continue; // It exited between the decision and the signal.
      console.log(`[advocate] ${a.name}: ${sig} → ${entry.id} (pid ${entry.pid}) — ${why}`);
      emit(a, 'closed', { id: entry.id, title: entry.title, detail: `${sig} — ${why}` });
      // SIGKILL is the last thing tried; anything still alive after it is not ours to
      // keep poking at. SIGTERM goes back on the list so `closeHardSeconds` can run.
      if (act === 'term') kept.push({ ...entry, sentAt: iso() });
    }
    a.closing = kept;
  }

  /**
   * The windows nobody is holding: finished sessions this advocate has no worker for.
   *
   * `reapClosing` can only reach a window whose pid is on the slot list, and the pile
   * auto-close was written for was made of windows that had left it long before the
   * feature existed. This is the other end of the same job — read every live session in
   * this workspace, and for each one that *calls itself* finished about a bead the
   * tracker says is closed, put it on the same closing list, where the four guards in
   * lib/reap.js decide the rest.
   *
   * It is a wider claim than a worker row, so: its own setting, a `DONE-` prefix the
   * session had to write itself, and a closed bead. See the header of lib/reap.js for
   * why those two are the ones that matter.
   *
   * Runs regardless of `paused` — pausing means "open no more sessions", not "leave the
   * screen full" — and never while observing, for the same reason `reapClosing` doesn't:
   * a signal is the least observable act there is.
   */
  async function sweepWindows(a, sessions) {
    // `closeFinishedSessions` is the whole feature's off switch, and it has to keep
    // being that: a window left alone on purpose which the sweep closed twenty minutes
    // later would make the switch a delay rather than a no.
    if (o.closeFinishedSessions === false || o.sweepFinishedWindows === false || OBSERVING) return;
    const every = clampInt(o.sweepIntervalMinutes, 1, 24 * 60, REAP_DEFAULTS.sweepIntervalMinutes);
    if (minsSince(a.lastWindowSweepAt) < every) return;
    a.lastWindowSweepAt = iso();

    const opts = { sweepIdleMinutes: clampInt(o.sweepIdleMinutes, 1, 24 * 60, REAP_DEFAULTS.sweepIdleMinutes) };
    for (const s of sessions) {
      const cand = sweepCandidate(s, opts);
      if (!cand) continue;
      // A window the advocate *is* holding goes through `reconcile` and `finish`, which
      // know what it was asked and can tell "closed its bead" from "was closed by
      // hand". Sweeping it as well would race that, on the same pid.
      if (a.workers.some((w) => Number(w.pid) === cand.pid || w.id === cand.id)) continue;
      if (a.closing.some((c) => c.pid === cand.pid)) continue;

      let bead;
      try {
        bead = await bd.show(a.workspace, cand.id);
      } catch {
        // No such bead, or a tracker that will not answer. Either way this is not
        // evidence that the window is finished, which is what it would take.
        continue;
      }
      if (bead?.status !== 'closed') continue;

      a.closing.push(sweepingFor(cand, bead));
      console.log(`[advocate] ${a.name}: ${cand.id} — a window nobody was holding, and its bead is closed (pid ${cand.pid})`);
    }
  }

  /* ---------------------------------------------------------------- launching */

  async function launch(a, bead) {
    const key = `${a.name}/${bead.id}`;
    const attempt = (a.attempts[bead.id] || 0) + 1;
    // A stale marker from the last attempt would retire this window the instant it
    // opened, which is the most confusing possible failure: a session that appears,
    // works, and is reported as having ended before it began.
    clearDone(a.name, bead.id);
    // And a check-in left over from a previous attempt on the same bead, for exactly
    // the same reason: it would answer a question this session was never asked.
    clearCheckin(a.name, bead.id);
    fs.mkdirSync(WORKER_DIR, { recursive: true });
    // Before the window, not after it, and before anything that can take twenty seconds:
    // the whole point of a lease is that the other Mac's next pull sees it, and a claim
    // written once iTerm had finished would be a claim written after the collision it
    // exists to lose. See lib/lease.js.
    const lease = await stake(a, bead.id);
    // `bd` is what lets the launcher refuse an unendorsed bead — it asks the tracker
    // rather than trusting the queue row, so the refusal holds even if the survey's
    // filter somehow handed it one. See lib/endorse.js.
    // A planner and a worker are the same launch through two different briefs, and the
    // survey has already decided which — `bead.planner` is the epic's ready children, put
    // there by `plansFor` (re-entry) or by `batchesFor` (an epic nobody has planned yet).
    // Both doors run the same endorsement and supersession refusals; see `openPlanSession`.
    const planning = Array.isArray(bead.planner);
    const { dir, mode, term } = planning
      ? await openPlan(cfg, a.workspace, bead, {
          kids: bead.planner,
          revising: Boolean(bead.revising),
          bd,
          doneFile: doneFileFor(a.name, bead.id),
        })
      : await open(cfg, a.workspace, bead, {
          attempt,
          bd,
          doneFile: doneFileFor(a.name, bead.id),
        });

    a.workers.push({
      id: bead.id,
      // The other beads this window was briefed on, when it is a batch head. `id` stays
      // the epic — which is what keeps every single-id thing downstream correct without
      // knowing batches exist at all: the done marker, the check-in, the attempt count
      // and `reclaim` are all still keyed by one bead, and `isDescendantOf(w.id, …)`
      // already reads every bead in the batch as underneath this worker, so the
      // suppression that stops a second window in this subtree covers the batch for
      // free. Empty for an ordinary single-bead window.
      // A planner's children go in here too, and that is not a fudge: `heldByChildren`'s
      // upward guard is keyed on `w.batch.length` for the exact question this needs
      // answered — is this worker one that was handed a whole subtree? A planner is, so a
      // sibling epic underneath it must not become its own dispatcher while it plans.
      // `w.group` below is the other case and deliberately does *not* set this: a group is
      // a slice of a subtree, not the subtree, and its lead must not hold the other groups.
      batch: planning ? (bead.planner || []).map((k) => k.id) : (bead.batch || []).map((k) => k.id),
      // Which group of which epic's plan this window carries, or null. Read by the card,
      // and by nothing that decides anything — what stops a second window in one group is
      // `dispatchable`, off `a.workers` by bead id, on every tick. See lib/plan.js.
      group: bead.group ? { epic: bead.group.epic, name: bead.group.name } : null,
      // A planner writes a plan and no code, which is worth saying on the card: a window
      // that closes without its bead closing reads as a session that gave up, and this one
      // finishing with the epic still open is the correct ending rather than a failure.
      planning,
      title: bead.title,
      priority: bead.priority,
      at: iso(),
      dir,
      // Which of the workspace's checkouts that directory is, or null where the
      // workspace has only the one. Derived from the directory the launch returned
      // rather than from the bead's label, so the card says where the window *went*
      // rather than where it was meant to go. See `repoNameFor`.
      repo: repoNameFor(a, dir),
      attempt,
      claimed: false,
      pid: null,
      sessionStatus: null,
      // The iTerm session id, kept for the life of the worker: it is what `reclaim`
      // addresses to ask this window whether it is still working. Null on an iTerm
      // that would not report one, which reclaim treats as "cannot ask".
      term: term || null,
      // The lease label staked above, so `reconcile` knows which of the labels on the
      // bead is ours to restamp and which is ours to take off when this worker ends.
      // Null when this Mac does not know who it is, which is the ordinary case.
      lease: lease || null,
      asked: null,
      checkedInAt: null,
      checkinNote: '',
    });
    a.lastLaunchAt = iso();

    // Reuse the phase chip every other agent in beadcause writes to: the bead now
    // shows as being worked on in the inbox, the graph and the monitor without any
    // of them knowing an advocate exists.
    setActivity(key, {
      phase: planning ? 'planning' : 'building',
      detail: `session opened by the ${a.name} advocate`,
      actor: 'advocate',
    });
    const inRepo = repoNameFor(a, dir);
    const what = planning
      ? `opened an epic worker on ${bead.id} to plan its ${bead.planner.length} ready ${bead.planner.length === 1 ? 'child' : 'children'}`
      : bead.group
        ? `opened a session on ${bead.id} for "${bead.group.name}" in ${bead.group.epic}'s plan`
        : `opened a session on ${bead.id}`;
    console.log(
      `[advocate] ${a.name}: ${what} in ${dir}${inRepo ? ` (${inRepo})` : ''} (${mode}, attempt ${attempt})`
    );
    emit(a, 'launched', {
      id: bead.id,
      title: bead.title,
      detail: planning
        ? `planning ${bead.id} in ${inRepo || path.basename(dir)}`
        : `session in ${inRepo || path.basename(dir)}`,
      repo: inRepo,
    });
  }

  /* -------------------------------------------------------------- the lease */

  /**
   * Write this Mac's claim on a bead, and hand back the label it wrote.
   *
   * Null and silent when this machine has no handle, which is every install that has
   * never heard of federation: no write, no label, nothing to read differently anywhere.
   *
   * A failure here is logged and never thrown, and the launch goes ahead. That is the
   * right direction and worth saying why, because refusing to launch would look like the
   * safer one: a machine that could not stake a claim is a machine that will *see* the
   * other's claim on the next tick and stand down, so the collision is still resolved and
   * still resolved the same way. Whereas a `bd` that timed out once would otherwise stop
   * this repo working any beads at all, which is a queue held up by a tracker hiccup.
   */
  async function stake(a, id) {
    // An observer instance reads the shared graph and writes nothing to it. A lease is
    // the most consequential write there is here — it takes a bead off another machine —
    // and a spare-port daemon booted to watch this one has no business staking any.
    if (!leasing() || OBSERVING) return null;
    const label = leaseLabel(me);
    if (!label) return null;
    try {
      await bd.addLabel(a.workspace, id, label);
      return label;
    } catch (err) {
      console.error(`[advocate] ${a.name}: could not claim ${id} for ${me} — ${err.message.split('\n')[0]}`);
      return null;
    }
  }

  /**
   * Take this Mac's claim back off a bead.
   *
   * Best-effort, and the reason it is only that is `leaseMinutes`: every lease expires,
   * so a removal that fails costs the other machine an hour rather than the bead. It is
   * still worth doing — an hour is a long time to leave work nobody is on looking like
   * work somebody is on, and every ending here is one where this Mac has finished with
   * the bead whatever it decided about it.
   */
  async function unstake(a, id, label) {
    if (!label || OBSERVING) return;
    try {
      await bd.removeLabel(a.workspace, id, label);
    } catch (err) {
      console.error(`[advocate] ${a.name}: could not release ${id} — ${err.message.split('\n')[0]}`);
    }
  }

  /**
   * Give up a window because another Mac's claim won.
   *
   * The loud half, and the half most likely to have been left out: lib/advocate.js's
   * third rule is that every cap is loud, and a session withdrawn in silence is
   * indistinguishable from one that finished. So four things happen and none of them is
   * optional — the window is *told*, in the one channel that reaches a live session; the
   * claim comes off, so the bead converges on one holder rather than staying contested;
   * the worker is finished with its own outcome, which puts the window on the reaper's
   * list to close once it is idle; and it goes on the card.
   *
   * Told rather than signalled, and that ordering matters: `finish` hands the window to
   * lib/reap.js, which waits for it to be idle before it sends anything. A session
   * mid-delivery gets to finish the sentence it is in and read why it is stopping, which
   * is the difference between standing down and being killed.
   *
   * `over` is the ancestor the claim is on, when it is not on this worker's own bead
   * (bc-etbq). It changes only what is *said*, and it has to: "beta's Mac claimed bc-bhp9.2
   * first" over a claim that is actually on bc-bhp9 sends the reader to a bead whose labels
   * do not mention beta, which is the one sentence here that could make a real collision
   * look like a bug in this file.
   */
  async function standDown(a, w, holder, { over = null } = {}) {
    const why = standDownWhy(holder, w.lease, { over });
    if (w.term && !OBSERVING) {
      try {
        await say(
          w.term,
          `Stand down: ${holder.handle}'s Mac claimed ${over || w.id} first, so the work ` +
            `${over ? `under ${over}, including ${w.id}, is theirs` : `on it is theirs`}. ` +
            `Do not deliver — commit anything worth keeping and stop.`
        );
      } catch (err) {
        // The window may have gone, or iTerm may refuse. It is still being stood down —
        // the message is a courtesy to a session that can hear it, not the mechanism.
        console.error(`[advocate] ${a.name}: could not tell ${w.id} to stand down — ${err.message.split('\n')[0]}`);
      }
    }
    await unstake(a, w.id, w.lease);
    w.lease = null;
    a.stoodDown = [{ id: w.id, title: w.title, why, handle: holder.handle, at: iso() }, ...(a.stoodDown || [])]
      // The card wants the recent ones, not a history: five is more than a day's worth of
      // a collision that should be rare, and an hour is long enough to still be reading
      // about it after the window it names has gone.
      .filter((s) => minsSince(s.at) < 60)
      .slice(0, 5);
    // No attempt charged, and the ones already charged are dropped: losing a coin toss
    // is not evidence about the bead, and `maxAttemptsPerBead` retiring work from this
    // machine's queue because another machine kept winning the race would be the one
    // failure here that never resolves itself.
    delete a.attempts[w.id];
    // `finish` does the log, the event and the hand-off to the reaper — so the window
    // closes once it is idle rather than being signalled mid-sentence. See lib/reap.js,
    // whose `REAPABLE` set this outcome joins.
    finish(a, w, `stood down — ${why}`, 'stood-down');
  }

  /** Beads this advocate may open a window on, in the order it would take them. */
  function candidates(a) {
    const busy = new Set(a.workers.map((w) => w.id));
    const settle = clampInt(o.settleSeconds, 0, 3600, DEFAULTS.settleSeconds);
    const maxAttempts = clampInt(o.maxAttemptsPerBead, 1, 10, DEFAULTS.maxAttemptsPerBead);
    return a.queue
      .filter((b) => !busy.has(b.id))
      .filter((b) => (a.attempts[b.id] || 0) < maxAttempts)
      // A bead is often still being written a few seconds after it appears — a
      // session that grabs it mid-sentence works from half a description.
      .filter((b) => secsSince(b.updatedAt) >= settle)
      .sort(byPickOrder);
  }

  /* ---------------------------------------------------------------- proposing */

  /**
   * Ask to create work, when there is none left to do.
   *
   * Only from an empty queue, and only once per cooldown: an advocate that
   * proposed while it still had beads to work would be doing the easy half of its
   * job instead of the useful one. The agent runs read-only — it can read the repo
   * and the tracker and nothing else — because its entire output is an argument,
   * and an argument does not need write access.
   */
  async function propose(a) {
    if (OBSERVING) return;
    const cooldown = clampInt(o.proposeCooldownHours, 1, 24 * 14, DEFAULTS.proposeCooldownHours) * 60;
    if (minsSince(a.lastProposalAt) < cooldown) return;

    // One open ask at a time. Two proposals in an inbox is how an advocate starts
    // reading as noise, and the second would be written without the answer to the
    // first.
    let open = [];
    try {
      open = await bd.listLabel(a.workspace, PROPOSAL_LABEL);
    } catch {
      return; // Can't tell — better to say nothing than to ask twice.
    }
    if (open.length) {
      note(a, `waiting on you to answer ${open[0].id} before proposing anything else`);
      return;
    }

    a.surveying = true;
    emit(a, 'surveying', { detail: 'looking for work worth proposing' });
    try {
      const surveyed = await surveyAgent(a);
      if (!surveyed.length) {
        a.lastProposalAt = iso();
        note(a, 'nothing worth proposing — idle');
        emit(a, 'idle', { detail: 'the survey found nothing worth filing' });
        return;
      }
      // The survey was *told* to skip anything an open bead already covers, and bc-9frx
      // is what happened when it did not. So every row is checked against the live set
      // here, where a prompt cannot lose: what it finds rides on the card, beside the
      // approve button, rather than being discovered by the second worker session.
      const beads = await flagDuplicates(a, surveyed);
      // The card has to be *seen* — bc-rfnr.2's inbox draws only what descends from a P0
      // you own, so a parentless proposal is an advocate asking a question on a screen
      // that will not show it. Nothing discovered this one, so it lands in the unsorted
      // backlog; a tracker with no such P0 files it exactly where it did. lib/homing.js.
      const { parent } = await homeIn(bd, a.workspace, {});
      const id = await bd.create(a.workspace, {
        title: proposalTitle(a.name, beads),
        body: proposalBody(a.name, beads),
        priority: 2,
        type: 'task',
        parent,
        labels: ['human', PROPOSAL_LABEL],
      });
      a.lastProposalAt = iso();
      console.log(`[advocate] ${a.name}: asking about ${beads.length} bead(s) — ${a.name}/${id}`);
      emit(a, 'proposed', { id, detail: `${beads.length} bead(s) for you to approve` });
      note(a, `asked you about ${beads.length} bead(s)`);
    } catch (err) {
      a.error = err.message.split('\n')[0];
      console.error(`[advocate] ${a.name}: proposal failed — ${a.error}`);
      emit(a, 'failed', { detail: a.error });
    } finally {
      a.surveying = false;
      persist();
    }
  }

  /**
   * Stamp each proposed bead with what it already looks like, if anything.
   *
   * Best-effort on purpose, and it is the one thing here that must not be able to lose
   * a proposal: a `bd list` that fails means the survey's ten minutes of work would be
   * thrown away over a lookup, and a proposal with no flag on it is exactly what every
   * proposal was until now. So the failure is logged and the unflagged beads go out.
   */
  async function flagDuplicates(a, beads) {
    let live = [];
    try {
      live = await bd.listStatus(a.workspace, 'open,in_progress,blocked');
    } catch (err) {
      console.error(`[advocate] ${a.name}: proposing without a duplicate check — ${err.message.split('\n')[0]}`);
      return beads;
    }
    const flagged = annotateDuplicates(beads, liveCandidates(live, { proposalLabel: PROPOSAL_LABEL }));
    for (const b of flagged) {
      if (!b.duplicate) continue;
      console.log(`[advocate] ${a.name}: "${b.title}" is ${dupeNote(b.duplicate)} — flagged on the card`);
      agentlog.append(`${a.name}/advocate`, `● ⚠︎ "${b.title}" is ${dupeNote(b.duplicate)}`);
    }
    return flagged;
  }

  /**
   * The read-only agent that writes the proposal.
   *
   * Streamed to a log the way lib/dispatch.js streams its replies, so "the advocate
   * is thinking" is something you can actually watch rather than a chip that sits
   * there for four minutes. Its answer has to come back as a fenced block: asking
   * for prose and parsing it later is how you end up filing a bead titled "Sure,
   * here are three ideas:".
   *
   * **It reads every checkout the workspace spans, and it is one agent rather than N.**
   * That is the answer to the question this was left out of the first sweep for. A
   * survey is not a question about a checkout the way "which pull requests are open" is
   * — it is a question about *the tracker*, "is this queue genuinely empty", and there is
   * exactly one of those per workspace however many repos it holds. Forty surveys would
   * be forty agents proposing into one graph, each blind to the other thirty-nine, and
   * `maxProposals` would stop meaning anything. So the survey stays one run, opened in
   * the `default` repo, with the rest of the approved list named on the command line —
   * `--add-dir`, because `claude` refuses a read outside its working directory and the
   * survey would otherwise propose work having read `architecture` and nothing else.
   *
   * The prompt has to say so as well as the flags: an agent given forty directories and
   * no sentence about them reads the one it is standing in. `checkoutBrief` is that
   * sentence, and it also asks for the `repo:` label a proposal about another checkout
   * needs — a bead filed without one belongs to the `default` repo (lib/repos.js), which
   * for work found in `athena-service` is the wrong answer, filed silently.
   */
  async function surveyAgent(a) {
    // Every approved checkout, and the one the run opens in. The `default` repo is the
    // right cwd — it is what a workspace-shaped question resolves to — but a multi-repo
    // workspace that has not named one throws rather than answering, and a survey is too
    // cheap to lose over that: any approved checkout is a home for a read-only run.
    const dirs = repoDirs(a);
    let dir;
    try {
      dir = resolveSessionDir(cfg, a.workspace);
    } catch (err) {
      if (!dirs.length) throw err;
      dir = dirs[0].dir;
    }
    const here = path.resolve(dir);
    const others = dirs.filter((r) => path.resolve(r.dir) !== here);
    const key = `${a.name}/advocate`;
    agentlog.reset(key);
    agentlog.append(
      key,
      `● surveying ${a.name} in ${dir}${others.length ? ` and ${others.length} other checkout(s)` : ''}`
    );

    // The advocate's foundation comes from the repo it advocates for, not from
    // beadcause's own checkout: an amendment is per agent kind, but it is stored
    // wherever that agent runs, so a repo can carry a differently-scoped advocate.
    const f = await effective(dir, 'advocate');

    // Tier 3: the private repo, its grant, and which arm of the experiment this run is.
    //
    // Provisioned here rather than at startup because the path carries the workspace and
    // this is the moment both halves are known. Everything about it is wrapped, because
    // an advocate that cannot survey a repo because its *diary* would not initialise is
    // a worse outcome than an experiment with a gap in it — the survey is the job, this
    // is the experiment riding along with it.
    let repo = null;
    try {
      const arm = agentrepo.armFor(a.name, f.id, o.agentRepo);
      if (arm) {
        await agentrepo.ensureAgentRepo(a.name, f.id);
        const grant = agentrepo.grantsFor(f, a.name, { arm });
        if (grant) {
          // The grant is added to the effective foundation rather than baked into the
          // baseline, for the reason `grantsFor` gives: the concrete path is per-run and
          // a foundation is what the agent is on every run.
          f.allowedTools = [...(f.allowedTools || []), ...grant.allowedTools];
          // Written before the agent starts, so a run that ignores the repo entirely is
          // still a run in the denominator. That is the half the prediction turns on.
          agentrepo.record({ workspace: a.name, agent: f.id, run: grant.run, arm, verb: 'session', kind: 'meta' });
          const index = arm === 'index' ? await agentrepo.indexOf(a.name, f.id) : null;
          repo = { grant, brief: agentrepo.repoBrief(index, { arm, owner: ownerName(cfg) }) };
          agentlog.append(key, `● tier 3: own repo, ${arm} arm`);
        }
      }
    } catch (err) {
      console.error(`[advocate] ${a.name}: no agent repo this run — ${err.message.split('\n')[0]}`);
    }

    // The survey is the one moment an advocate has just spent ten minutes finding
    // out what it could not see, which makes it the right place to ask whether the
    // means were missing rather than the work.
    //
    // `propose: true` because this is the one agent with a `beadproposal` block of its
    // own, so the reflection can point at it for the changes an amendment may not ask
    // for. See the tail of `amendment.reflectionPrompt`.
    let reflection = '';
    try {
      reflection = amendment.reflectionPrompt(f, await amendment.refusalsFor(dir, 'advocate'), ownerName(cfg), {
        propose: true,
      });
    } catch (err) {
      console.error(`[advocate] ${a.name}: no reflection step — ${err.message.split('\n')[0]}`);
    }

    const promptFile = path.join(os.tmpdir(), `beadcause-advocate-${crypto.randomBytes(6).toString('hex')}.md`);
    fs.writeFileSync(
      promptFile,
      surveyPrompt(
        a.name,
        o,
        reflection,
        ownerName(cfg),
        repo?.brief || '',
        confluenceBrief(cfg, ownerName(cfg)),
        checkoutBrief(a, dir, others)
      ),
      { mode: 0o600 }
    );
    const command =
      `P="$(cat '${promptFile}')"; rm -f '${promptFile}'; ` +
      `exec claude -p ${claudeArgs(f, { addDirs: others.map((r) => r.dir) }).join(' ')} --output-format stream-json --verbose ` +
      // The survey prompt is generated and opens with prose, so this is the one site
      // where a leading dash is not reachable today. It carries the `--` anyway: the
      // guard costs two characters, and the alternative is five call sites with four
      // different rules. See `promptArgs`.
      promptArgs().join(' ');

    return new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd: dir,
        // See `agentEnv`: `beadcause-memory` on PATH, and who this agent is stamped
        // where it cannot claim to be somebody else. The tier 3 grant rides in as
        // `extra`, which `agentEnv` spreads *after* `foundation.env` — so an amended
        // env cannot repoint the wrapper at another agent's directory.
        env: agentEnv(f, repo?.grant.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let pending = '';
      let answer = '';
      let stderr = '';
      // Read off the transcript rather than taken on trust — see `amendment.denialFrom`.
      const denials = [];

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            agentlog.append(key, line);
            continue;
          }
          const rendered = agentlog.renderEvent(event);
          if (rendered) agentlog.append(key, rendered);
          if (event.type === 'result' && typeof event.result === 'string') answer = event.result;
          const denied = amendment.denialFrom(event);
          if (denied && denials.length < 5 && !denials.includes(denied)) denials.push(denied);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        agentlog.append(key, String(chunk).trimEnd());
      });

      const timer = setTimeout(() => child.kill('SIGTERM'), o.proposeTimeoutMs ?? DEFAULTS.proposeTimeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        fs.rmSync(promptFile, { force: true });
        if (code !== 0) {
          agentlog.append(key, `● failed: exited ${code}`);
          return reject(new Error((stderr || `survey agent exited ${code}`).split('\n')[0]));
        }
        const parsed = parseProposal(answer);
        // Not "nothing proposed": the survey may have found nothing in the repo and still
        // have something to say about itself, and the two used to be the same line.
        if (!parsed) agentlog.append(key, '● the survey found nothing in the repo to propose');
        if (parsed?.error) {
          agentlog.append(key, `● ${parsed.error}`);
          return reject(new Error(parsed.error));
        }
        const capped = (parsed?.beads || []).slice(0, clampInt(o.maxProposals, 1, 20, DEFAULTS.maxProposals));
        if (parsed && capped.length < parsed.beads.length) {
          // Never a silent truncation: the difference between "it found three" and
          // "it found eleven and you are seeing three" is the whole of the picture.
          agentlog.append(key, `● proposing ${capped.length} of ${parsed.beads.length} (maxProposals)`);
          console.log(`[advocate] ${a.name}: survey returned ${parsed.beads.length}, proposing ${capped.length} (maxProposals)`);
        }

        // Separately from the proposal, and after it: what the advocate wants for
        // itself must never interfere with what it found for you. A survey that
        // proposed nothing can still have hit a wall worth hearing about — and when the
        // wall is one an amendment may not remove, the ask comes back as one more bead
        // to ride the same card. Appended after the cap on purpose: `maxProposals`
        // bounds what the survey found in the repo, and dropping the agent's own
        // request to honour it would be the silent loss this whole path exists to stop.
        selfRequest(a, dir, key, answer, denials).then(
          (extra) => {
            const beads = extra ? [...capped, extra] : capped;
            agentlog.append(key, `● proposing ${beads.length} bead(s)`);
            resolve(beads);
          },
          (err) => {
            // Never allowed to break the survey. The proposal is the job; this is a
            // by-product of having done it.
            console.error(`[advocate] ${a.name}: self-request failed — ${err.message.split('\n')[0]}`);
            agentlog.append(key, `● proposing ${capped.length} bead(s)`);
            resolve(capped);
          }
        );
      });
    });
  }

  /**
   * The advocate's own request, if it made one — and which of the two doors it goes
   * through.
   *
   * An amendment and a code change are the same conclusion arriving in the same block,
   * and they have to be routed apart because only one of them can be *applied*. A field
   * in `AMENDABLE` becomes the amendment card Adam approves, and the foundation moves.
   * Anything else — a protected field, the brief it was handed, a field name that is
   * nothing in the foundation at all — cannot move without a commit, so it comes back
   * here as a bead to fold into the proposal card this survey is already filing.
   *
   * Resolves to that bead, or to null, which is the answer for almost every survey.
   */
  async function selfRequest(a, dir, key, text, denials) {
    const request = amendment.parseAmendment(text);
    if (!request) return null;
    // The agent's own account, plus what the transcript actually shows — before the
    // routing, because both doors want the evidence.
    if (denials.length) {
      request.evidence = [request.evidence, ...denials.map((d) => `- ${d}`)].filter(Boolean).join('\n');
    }
    if (request.beyond) return proposeSelfChange(a, dir, key, request);
    if (request.error) {
      console.error(`[advocate] ${a.name}: ignoring a malformed amendment request — ${request.error}`);
      agentlog.append(key, `● amendment request rejected: ${request.error}`);
      return null;
    }
    await fileAmendment(a, dir, key, request);
    return null;
  }

  /**
   * A request an amendment may not grant, as one more proposed bead.
   *
   * The same two filters the amendment card gets, and that is the bead's own
   * requirement rather than a nicety: an agent that has been told no, or that already
   * has a question open, must not get to re-ask by picking the other channel. See
   * `amendment.openSelfAsk` — one rule, both doors.
   *
   * Nothing is created here. The bead is *proposed*, on the card Adam was already going
   * to be asked to approve, so the agent has gained a way to be heard and no way to
   * write. What it costs if this goes wrong is one line in the survey log.
   */
  async function proposeSelfChange(a, dir, key, request) {
    const fields = request.beyond.join(', ');
    agentlog.append(key, `● it asked for something only a commit can change: ${fields}`);
    if (await amendment.alreadyRefused(dir, request)) {
      agentlog.append(key, '● dropped: you have already said no to this');
      return null;
    }
    const open = await amendment.openSelfAsk(bd, a.workspace);
    if (!open.known || open.id) {
      agentlog.append(key, `● held back: ${open.id ? `${open.id} is already open` : 'could not read what is open'}`);
      return null;
    }
    const bead = amendment.beyondAmendment(request, await effective(dir, request.agent), {
      workspace: a.name,
      from: `the ${a.name} survey`,
    });
    if (!bead) return null;
    console.log(`[advocate] ${a.name}: asked for ${fields}, which only a commit can change — proposing a bead instead`);
    agentlog.append(key, '● proposing it as a bead instead');
    return bead;
  }

  /**
   * File the advocate's own request to be different, when it is one an amendment can
   * actually carry.
   *
   * Same filters as lib/dispatch.js applies, for the same reason: a request re-arguing
   * something already refused, and a second request while one is open, are both noise in
   * the one channel Adam reads for constitutional questions, and noise there is what
   * makes him stop opening it.
   */
  async function fileAmendment(a, dir, key, request) {
    try {
      if (await amendment.alreadyRefused(dir, request)) {
        agentlog.append(key, '● amendment request dropped: you have already said no to this');
        return;
      }
      const filed = await amendment.fileRequest(bd, a.workspace, dir, request, { from: `the ${a.name} survey` });
      if (!filed) return;
      if (filed.skipped) {
        agentlog.append(key, `● amendment request held back: ${filed.skipped}`);
        return;
      }
      console.log(`[advocate] ${a.name}: asked to change what it is — ${a.name}/${filed.id}`);
      agentlog.append(key, `● asked to change its own foundation — ${filed.id}`);
      emit(a, 'proposed', { id: filed.id, detail: 'it is asking to change what it is' });
    } catch (err) {
      console.error(`[advocate] ${a.name}: could not file an amendment request — ${err.message.split('\n')[0]}`);
    }
  }

  /* --------------------------------------------------------------- archiving */

  /**
   * Put each finished session's log in the repo, beside the commits it made.
   *
   * Runs before the sweep, and that order is load-bearing: the sweep moves the
   * worktree, and the archive needs it where the session left it to find the branch.
   */
  async function archiveFinished(a) {
    if (!a.finished.length) return;
    const finished = a.finished;
    a.finished = [];
    // Observing writes nothing into the repo either: an archive is a git ref and a
    // note on somebody else's commits, in a checkout this instance is only visiting.
    if (!o.sessionLog || OBSERVING) return;

    /**
     * Which checkout each log goes into: **the one that session actually ran in**.
     *
     * `refs/beadcause/sessions/<bead>` is stored inside the repo the work happened in,
     * which is the whole point of storing it in refs rather than in a directory — the
     * log travels with the commits it describes. That was free while a workspace was one
     * checkout, and asking `resolveSessionDir` for the workspace's directory said the
     * same thing. A workspace holding forty repos has no such directory, and answering
     * with the fallback would write every Climative session's log into `architecture`:
     * the ref would exist, in a repo whose commits it does not describe, and the repo the
     * work is in would have none.
     *
     * The worker record already knows — `dir` on it is what `openWorkSession` launched
     * that session in, resolved from the bead's own service token. So the archive follows
     * the session rather than re-deriving where it should have been, and a worker whose
     * record predates that field (a daemon restarted mid-session) falls back to the
     * workspace's own answer, which is what it always used.
     */
    let fallback = null;
    try {
      fallback = resolveSessionDir(cfg, a.workspace);
    } catch {
      fallback = null;
    }
    const withTranscript = Boolean(o.perWorkspace?.[a.name]?.sessionTranscripts ?? o.sessionTranscripts);

    for (const { worker, outcome } of finished) {
      const dir = worker.dir || fallback;
      if (!dir) continue;
      try {
        const res = await archiveSession(dir, {
          workspace: a.name,
          bead: worker.id,
          title: worker.title,
          sessionId: worker.sessionId || null,
          startedAt: worker.at,
          outcome,
          includeTranscript: withTranscript,
        });
        a.lastArchive = { bead: worker.id, ref: res.ref, commits: res.commits.length, at: iso() };
        console.log(
          `[advocate] ${a.name}: archived ${worker.id} → ${res.ref}` +
            ` (${res.commits.length} commit(s)${res.includedTranscript ? ', with transcript' : ''})`
        );
        emit(a, 'archived', { id: worker.id, detail: `${res.commits.length} commit(s) → ${res.ref}` });
        // Nothing to note on a landing that hasn't happened yet — remember it and
        // let the sweep, which already asks whether a branch reached main, do it.
        if (res.head && !res.merged) {
          // `dir` travels with it: the note goes on commits in the same repo as the ref,
          // and the sweep that writes it runs long after this worker record is gone.
          a.pendingNotes.push({ bead: worker.id, ref: res.ref, head: res.head, branch: res.branch, dir });
        }
      } catch (err) {
        console.error(`[advocate] ${a.name}: could not archive ${worker.id} — ${err.message.split('\n')[0]}`);
      }
    }
  }

  /**
   * Note the commit that finally brought an archived session's branch into main.
   *
   * Cheap enough to run on every sweep: one `merge-base --is-ancestor` per pending
   * entry, and there are normally none.
   */
  async function notePending(a, dir) {
    if (!a.pendingNotes.length || !o.sessionLog || OBSERVING) return;
    const still = [];
    const usePr = cfg.pr?.enabled !== false && cfg.pr?.tidyMerged !== false;
    // One `mainCheckout` per repo rather than one for the sweep: two entries can be in
    // two different checkouts of the same workspace, and the note has to go on the
    // commits that actually carry the work.
    const mains = new Map();
    const mainFor = async (d) => {
      if (!mains.has(d)) mains.set(d, await mainCheckout(d).catch(() => null));
      return mains.get(d);
    };
    for (const p of a.pendingNotes) {
      try {
        // A note whose entry predates `archiveFinished` learning the repo, in a workspace
        // whose `dir` could not be resolved either: there is no checkout to put it on, so
        // it waits rather than being dropped or asked of the wrong repo.
        if (!p.dir && !dir) {
          still.push(p);
          continue;
        }
        const main = await mainFor(p.dir || dir);
        if (!main) {
          still.push(p);
          continue;
        }
        const merged = await mergeCommitFor(main, p.head, { branch: p.branch, usePr });
        if (!merged) {
          still.push(p);
          continue;
        }
        await noteMerge(main, { sha: merged, bead: p.bead, workspace: a.name, ref: p.ref });
        console.log(`[advocate] ${a.name}: ${p.bead} landed in ${merged.slice(0, 8)} — noted`);
      } catch {
        // A branch that has been deleted outright can never land; dropping it is
        // the honest end, and keeping it would retry forever.
      }
    }
    a.pendingNotes = still;
  }

  /* ---------------------------------------------------------------- tidying */

  /**
   * Clear up after sessions that have ended — see lib/tidy.js for the five
   * conditions and why each one is there.
   *
   * Runs regardless of `paused`, because pausing an advocate means "open no more
   * sessions", not "leave the mess". It is switched off on its own with
   * `tidyWorktrees: false`, which is the setting that actually means that.
   *
   * Observing switches it off too, and here the reason is sharper than "don't act":
   * the worktrees are the *main checkout's*, shared with every session and every
   * other instance, so a spare-port daemon retiring one is reaching outside its own
   * config directory to move somebody else's work.
   *
   * **Every checkout, for the reason the queue's sweeps take them all** (see
   * `repoDirs`) — but the argument is a different one, and worth saying because it is
   * the reason this was left behind when they were done. Those three are questions
   * whose *wrong* answer hands out a window: a bead whose pull request is open one repo
   * along looks, to a sweep that asked only the default repo, exactly like a bead nobody
   * has started. Nothing here is like that. A worktree in `athena-service` that is never
   * retired breaks nothing at all — it simply sits there, and so does the attic behind
   * it, in thirty-nine repos, forever. It is a leak rather than a bug, which is why it
   * could wait and why it still had to be fixed.
   *
   * `.claude/worktrees/` is per checkout, so this genuinely is N sweeps: one
   * `mainCheckout`, one `git worktree list` and one attic walk per approved repo. They
   * are not merged the way the queue's answers are — there is nothing to merge, because
   * a worktree in one repo is not a candidate answer to a question about another — so
   * the card carries a row per repo and the summary names each one that moved.
   */
  async function tidy(a, sessions) {
    if (!o.tidyWorktrees || OBSERVING) return;
    const due = a.sweepDue || minsSince(a.lastTidyAt) >= clampInt(o.tidyIntervalMinutes, 1, 24 * 60, DEFAULTS.tidyIntervalMinutes);
    if (!due) return;

    // Empty for a scratch tracker with no checkout at all, and for an approved list
    // none of whose repos are on disk. Nothing here has worktrees to sweep, and that
    // is an answer rather than an error — see `repoDirs`.
    const dirs = repoDirs(a);
    if (!dirs.length) return;

    a.sweepDue = false;
    a.lastTidyAt = iso();
    // One call for the workspace rather than one per checkout: each pending note already
    // carries the directory its commits are in (`archiveFinished` puts it there), so this
    // walks the list once and the repo travels with the entry.
    await notePending(a, dirs[0].dir);

    // `prMerges` is what makes the sweep keep working now that nothing merges
    // locally: a squash-merged branch is never an ancestor of main, so without it
    // every delivered worktree would sit there forever being described as unmerged.
    const prMerges = cfg.pr?.enabled !== false && cfg.pr?.tidyMerged !== false;
    /** One entry per approved checkout, in the order the `approved` list is written. */
    const each = [];
    const failed = [];
    for (const repo of dirs) {
      try {
        const result = await sweepWorktrees(repo.dir, { sessions, prMerges });
        // Retiring and expiring are two halves of one job and run on one tick. The
        // expiry goes second because the sweep it follows has just added to the attic,
        // and an entry retired this second is a long way from the age line anyway.
        const attic = await expireRetired(repo.dir, { sessions, prMerges, days: atticDays(o) });
        // Third and last, because it walks what the other two just left behind and there
        // is no point weighing a dependency tree in an entry that is about to be removed.
        // Age is not one of its gates — see `slimAttic` — so it slims what was retired
        // this same tick, which is how a fat worktree never reaches the age line at all.
        const slim = await slimAttic(repo.dir, { sessions });
        each.push({
          repo: repo.name,
          summary: [describeSweep(result), describeExpiry(attic), describeSlim(slim)].filter(Boolean).join(' · '),
          retired: result.retired.length,
          expired: attic.removed.length,
          slimmed: slim.slimmed.length,
          freedBytes: slim.bytes,
          error: null,
        });
      } catch (err) {
        // One checkout is not the sweep, the same rule the queue's sweeps keep: a repo
        // with no `main` to compare against, or one somebody has moved out from under
        // the approved list, must not stop the other thirty-nine being tidied.
        const why = err.message.split('\n')[0];
        each.push({ repo: repo.name, summary: '', retired: 0, expired: 0, slimmed: 0, freedBytes: 0, error: why });
        failed.push(`${inWhich(repo)}${why}`);
        console.error(`[advocate] ${a.name}: ${inWhich(repo)}worktree sweep failed — ${why}`);
      }
    }

    const total = (key) => each.reduce((n, e) => n + e[key], 0);
    // The repo prefix comes from `inWhich`, so a single-repo workspace's summary is the
    // string it has always been — no `beadcause: ` in front of it, and no row to read.
    const moved = each.filter((e) => e.summary).map((e) => `${inWhich({ name: e.repo })}${e.summary}`);
    const trouble = !failed.length
      ? ''
      : failed.length === each.length
        ? `sweep failed: ${failed[0]}`
        : `${failed.length} of ${each.length} checkouts did not answer: ${failed[0]}`;
    const summary = [...moved, trouble].filter(Boolean).join(' · ');
    a.tidy = {
      summary,
      retired: total('retired'),
      expired: total('expired'),
      slimmed: total('slimmed'),
      freedBytes: total('freedBytes'),
      // Absent for every single-repo workspace, like every other per-repo field on this
      // card: there is nothing for a row to say that the summary does not already.
      ...(multiRepo(cfg, a.name) ? { repos: each } : {}),
      at: a.lastTidyAt,
    };
    // Only when something moved. A sweep that found nothing to do is the normal
    // case and would otherwise print every fifteen minutes for every repo.
    if (a.tidy.retired || a.tidy.expired || a.tidy.slimmed) {
      console.log(`[advocate] ${a.name}: ${summary}`);
      emit(a, 'tidied', { detail: summary });
    }
  }

  /* ------------------------------------------------------- landed elsewhere */

  /**
   * Close the beads whose pull request merged on github.com — see lib/landed.js.
   *
   * Two callers, and the difference between them is the whole point. On the interval
   * this is housekeeping: a bead nothing closed is wrong on the card and wrong in
   * `bd ready` whether or not anything is about to be opened on it. Before a launch it
   * is `force`, and it is not housekeeping at all — it is the last moment anything can
   * find out that the work it is about to spend twenty minutes and a window on is
   * already in `main`. bc-4irq is what that costs when nobody asks: two sessions, the
   * second of which existed only to discover the first had already landed.
   *
   * Returns whether anything closed, because the caller has a queue built from a survey
   * taken before this ran and it is now out of date by exactly those beads.
   */
  async function landed(a, { force = false } = {}) {
    if (o.reconcileLanded === false || OBSERVING) return false;
    if (cfg.pr?.enabled === false) return false;
    const due = force || minsSince(a.lastLandedAt) >= clampInt(o.landedIntervalMinutes, 1, 24 * 60, DEFAULTS.landedIntervalMinutes);
    if (!due) return false;

    // Every checkout, for the reason `inflight` above takes them all: a Climative bead's
    // pull request merged in the repo the bead is about, and a sweep that asked only
    // `architecture` would leave it open and hand a window to work already in `main` —
    // which is bc-4irq, one repo along. See `repoDirs`.
    const dirs = repoDirs(a);
    if (!dirs.length) return false;

    a.lastLandedAt = iso();
    const result = { ok: false, reason: '', closed: [], skipped: [], cards: [], truncated: null };
    // Two ways for one checkout to give nothing, kept apart because they mean different
    // things: `threw` is something broken and belongs in the error log, `quiet` is `gh`
    // not being there or a repo with no remote and belongs nowhere but the card.
    const threw = [];
    const quiet = [];
    for (const repo of dirs) {
      let one;
      try {
        // `key` is which repo this checkout is, and it is only used to ask for the
        // conflict sweep a merge on github.com owes (rule 5 in lib/landed.js). Built
        // here rather than there because `repoDirs` above is what knows: it is the one
        // place that has already decided whether this workspace is one repo or forty.
        one = await reconcileLanded(bd, a.workspace, repo.dir, {
          base: cfg.pr?.base || 'main',
          key: repoKey(a.name, repo.name ? { name: repo.name } : null),
        });
      } catch (err) {
        // A sweep is a courtesy on top of the tick and may not take it down, and one
        // checkout is not the sweep: the other thirty-nine still have beads whose work
        // merged, and the whole point of asking them was to close those.
        threw.push(`${inWhich(repo)}${err.message.split('\n')[0]}`);
        continue;
      }
      if (!one.ok) {
        if (one.reason) quiet.push(one.reason);
        continue;
      }
      result.ok = true;
      result.closed.push(...(one.closed || []));
      result.skipped.push(...(one.skipped || []));
      result.cards.push(...(one.cards || []));
      // What the sweep did about *this Mac* — bc-6sqs, rule 4 in lib/landed.js. Said per
      // checkout and in landLocally's own words, because the interesting answers are the
      // refusals ("left main where it is — there is uncommitted work in beadcause:
      // .beads/ (all untracked)") and which checkout they are about is half of acting on
      // one. Only when it did something or declined to: the ordinary tick closes nothing
      // and this is silent.
      if (one.landed?.note) console.log(`[advocate] ${a.name}: ${inWhich(repo)}${one.landed.note}`);
      // The reach warning belongs to whichever repo hit the cap; one is enough to say
      // the window was not covered, and naming more of them would not change the fix.
      if (one.truncated && !result.truncated) result.truncated = one.truncated;
    }
    if (threw.length && !result.ok) {
      a.landed = { summary: `landed sweep failed: ${threw[0]}`, closed: 0, at: a.lastLandedAt };
      console.error(`[advocate] ${a.name}: landed sweep failed — ${threw[0]}`);
      return false;
    }
    if (!result.ok) result.reason = quiet[0] || threw[0] || '';

    const summary = describeLanded(result);
    // Said when it changes rather than when it holds. A cap that bit is a standing state
    // — true again in ten minutes, and again after that — so logging it per sweep would
    // be 144 identical lines a day and read as noise on the one day it starts being true.
    // Which is the day it matters: from then on, a bead older than the sweep's reach is
    // stranded for good rather than for a fortnight, and this is the only notice of it.
    // Compared on the cap and the reach in whole days, not on the sentence: the sentence
    // carries the oldest row's date, which moves on every sweep, so comparing those would
    // log every time and be exactly the noise this is avoiding.
    const reachKey = (t) => (t ? `${t.limit}/${t.days}` : '');
    const before = a.landed?.truncated || null;
    if (result.truncated && reachKey(result.truncated) !== reachKey(before)) {
      console.log(`[advocate] ${a.name}: landed sweep did not reach the whole window — ${describeTruncation(result.truncated)}`);
    }
    a.landed = {
      summary,
      closed: result.closed.length,
      cards: (result.cards || []).length,
      truncated: result.truncated || null,
      at: a.lastLandedAt,
    };
    if (!result.closed.length) {
      // A sweep that closed only a stale delivery card did something worth a line and
      // nothing worth a requeue: the card left the phone, but no bead changed state, so
      // the caller's survey is still true. Logged here rather than below because the
      // return value below means "your queue is out of date", which this is not.
      if (summary) console.log(`[advocate] ${a.name}: ${summary}`);
      return false;
    }

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const c of result.closed) {
      emit(a, 'landed', {
        id: c.id,
        title: c.title,
        detail: `merged on GitHub as #${c.number}${c.sha ? ` (${String(c.sha).slice(0, 8)})` : ''} — closed without opening a session`,
      });
    }
    // Anything skipped for a reason that is not "this is old news" is worth a line: a
    // bead this could not close is a bead a session will be opened on, and finding that
    // out from the log beats finding it out from the window.
    for (const s of result.skipped) {
      if (s.id) console.log(`[advocate] ${a.name}: left ${s.id} open — ${s.why}`);
    }
    return true;
  }

  /* --------------------------------------------------- superseded duplicates */

  /**
   * Put the duplicates whose original has closed in front of Adam — see
   * lib/superseded.js.
   *
   * The mirror image of `landed` above, and worth saying how: that one closes beads
   * whose work turns out to be done, this one *asks* about beads whose work turns out to
   * belong to somebody else. The difference is who is entitled to decide. A merged pull
   * request is a fact the daemon can read off GitHub, so closing on it is bookkeeping; "these
   * two beads are the same job" is a judgement a worker made in passing, and acting on
   * it unasked would be the daemon closing work on an agent's say-so.
   *
   * Runs regardless of `paused`, like `tidy` does, because pausing an advocate means
   * "open no more sessions" and this opens nothing — it is the one thing standing
   * between a marked bead and being invisible forever. `OBSERVING` does stop it: a
   * spare-port instance writing to the tracker is reaching outside its own config
   * directory, and three lines on somebody else's bead is exactly that.
   */
  async function askSuperseded(a) {
    if (o.askSuperseded === false || OBSERVING) return;
    const due =
      minsSince(a.lastSupersededAt) >=
      clampInt(o.supersededIntervalMinutes, 1, 24 * 60, DEFAULTS.supersededIntervalMinutes);
    if (!due) return;

    a.lastSupersededAt = iso();
    let result;
    try {
      result = await sweepSuperseded(bd, a.workspace);
    } catch (err) {
      // A sweep is a courtesy on top of the tick and may not take it down: whatever went
      // wrong, the advocate still has a queue to work.
      a.superseded = { summary: `superseded sweep failed: ${err.message.split('\n')[0]}`, asked: 0, at: a.lastSupersededAt };
      console.error(`[advocate] ${a.name}: superseded sweep failed — ${err.message.split('\n')[0]}`);
      return;
    }

    const summary = describeSuperseded(result);
    a.superseded = { summary, asked: result.asked.length, at: a.lastSupersededAt };
    // Every skip is worth a line, and this is the one sweep where that is true without
    // exception: a bead it could not ask about is a bead nothing will ever ask about
    // again, held out of every queue by a marker only this can act on.
    for (const s of result.skipped) console.log(`[advocate] ${a.name}: left ${s.id} held — ${s.why}`);
    if (!result.asked.length) return;

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const q of result.asked) {
      emit(a, 'superseded', {
        id: q.id,
        title: q.title,
        detail: `${q.original} closed — asked whether this goes with it, rather than opening a session on it`,
      });
    }
  }

  /* ------------------------------------------------- branches already in main */

  /**
   * Ask about the open beads whose branch is already in `main` — see lib/inmain.js.
   *
   * Third of three, and the family is worth reading as one: `landed` closes a bead whose
   * pull request GitHub says merged; `askSuperseded` asks about a bead a worker said was
   * somebody else's job; this asks about a bead whose *branch* git says is already in.
   * The evidence gets weaker down that list and the daemon's licence narrows with it —
   * the first closes, and the other two may only ask, because a bead can name a branch
   * that landed and still want more than what landed.
   *
   * Deliberately **before the survey**, unlike `askSuperseded`, and that ordering is the
   * point rather than housekeeping: the label this writes is what takes the bead out of
   * `bd ready`, so a bead flagged here is out of the queue built immediately below and no
   * session is opened on it this tick. There is no re-survey to do afterwards, which is
   * the whole difference from `landed` — that one closes beads a survey has already been
   * taken over, and has to take it again.
   *
   * Runs while paused, for the same reason `tidy` and `askSuperseded` do: pausing an
   * advocate means "open no more sessions", and this opens nothing. `OBSERVING` stops it
   * inside lib/inmain.js's caller below — a spare-port instance writing to somebody
   * else's tracker is exactly what that flag is for.
   */
  async function flagInMain(a) {
    if (o.flagInMain === false || OBSERVING) return;
    const due = minsSince(a.lastInMainAt) >= clampInt(o.inMainIntervalMinutes, 1, 24 * 60, DEFAULTS.inMainIntervalMinutes);
    if (!due) return;

    // Every checkout, for the reason the two sweeps above take them all: a branch is in
    // the `main` of the repo it was cut from, and nowhere else. See `repoDirs`.
    const dirs = repoDirs(a);
    if (!dirs.length) return;

    a.lastInMainAt = iso();
    const result = { ok: false, reason: '', flagged: [], skipped: [] };
    const threw = [];
    const quiet = [];
    for (const repo of dirs) {
      let one;
      try {
        one = await sweepInMain(bd, a.workspace, repo.dir, { base: cfg.pr?.base || 'main' });
      } catch (err) {
        // A sweep is a courtesy on top of the tick and may not take it down, and one
        // checkout refusing is not the sweep failing.
        threw.push(`${inWhich(repo)}${err.message.split('\n')[0]}`);
        continue;
      }
      if (!one.ok) {
        if (one.reason) quiet.push(one.reason);
        continue;
      }
      result.ok = true;
      result.flagged.push(...(one.flagged || []));
      result.skipped.push(...(one.skipped || []));
    }
    if (threw.length && !result.ok) {
      a.inMain = { summary: `in-main sweep failed: ${threw[0]}`, flagged: 0, at: a.lastInMainAt };
      console.error(`[advocate] ${a.name}: in-main sweep failed — ${threw[0]}`);
      return;
    }
    if (!result.ok) result.reason = quiet[0] || threw[0] || '';

    const summary = describeInMain(result);
    a.inMain = { summary, flagged: result.flagged.length, at: a.lastInMainAt };
    // Only the skips that are not "this branch has not landed", which is the ordinary
    // state of most branches and would otherwise be a line per branch per interval
    // forever. What is left is a ref that has gone, a git that could not answer, and a
    // write the tracker refused — each of which is a bead this could not protect.
    for (const s of result.skipped) {
      if (!s.quiet) console.log(`[advocate] ${a.name}: left ${s.id} alone — ${s.why}`);
    }
    if (!result.flagged.length) return;

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const f of result.flagged) {
      emit(a, 'inmain', {
        id: f.id,
        title: f.title,
        detail: `${f.branch} is already in ${f.base}${f.commit ? ` (${String(f.commit).slice(0, 8)})` : ''} — asked whether it is finished, rather than opening a session on it`,
      });
    }
  }

  /* ------------------------------------------- closed over a branch that never landed */

  /**
   * File a card about the closed beads whose own branch never reached `main` — see
   * lib/notinmain.js.
   *
   * The fourth of the family and the only one pointed at *closed* beads, which is why it
   * is the only one that cannot put its question on the bead it is about: `bd human list`
   * returns open issues, so the finding is a new bead naming the closed one. It is also
   * the only one whose failure costs work rather than time — the other three save a
   * session, this one is the difference between a feature being missing and somebody
   * knowing it is missing.
   *
   * After the survey rather than before it, and that is the difference from `flagInMain`
   * above: nothing this writes changes what is in `bd ready` this tick — the bead it is
   * about is closed and stays closed, and the card it files is `human` from birth and so
   * was never in the queue. Running it early would only make the survey wait on a `gh pr
   * list` per branch.
   *
   * Runs while paused, like the rest of the family: pausing means "open no more
   * sessions", and this opens none. `OBSERVING` stops it, because a spare-port instance
   * filing beads in somebody else's tracker is exactly what that flag is for.
   */
  async function flagNotInMain(a) {
    if (o.flagNotInMain === false || OBSERVING) return;
    const due =
      minsSince(a.lastNotInMainAt) >= clampInt(o.notInMainIntervalMinutes, 1, 24 * 60, DEFAULTS.notInMainIntervalMinutes);
    if (!due) return;

    const dirs = repoDirs(a);
    if (!dirs.length) return;

    a.lastNotInMainAt = iso();
    const result = { ok: false, reason: '', flagged: [], skipped: [], unasked: 0 };
    const threw = [];
    const quiet = [];
    for (const repo of dirs) {
      let one;
      try {
        one = await sweepNotInMain(bd, a.workspace, repo.dir, { base: cfg.pr?.base || 'main' });
      } catch (err) {
        threw.push(`${inWhich(repo)}${err.message.split('\n')[0]}`);
        continue;
      }
      if (!one.ok) {
        if (one.reason) quiet.push(one.reason);
        continue;
      }
      result.ok = true;
      result.flagged.push(...(one.flagged || []));
      result.skipped.push(...(one.skipped || []));
      result.unasked += one.unasked || 0;
    }
    if (threw.length && !result.ok) {
      a.notInMain = { summary: `not-in-main sweep failed: ${threw[0]}`, flagged: 0, at: a.lastNotInMainAt };
      console.error(`[advocate] ${a.name}: not-in-main sweep failed — ${threw[0]}`);
      return;
    }
    if (!result.ok) result.reason = quiet[0] || threw[0] || '';

    const summary = describeNotInMain(result);
    a.notInMain = { summary, flagged: result.flagged.length, unasked: result.unasked, at: a.lastNotInMainAt };
    // The loud skips only: a branch that landed, or has nothing on it, or has already
    // been asked about is the ordinary answer for nearly every branch on this laptop.
    // What is left is a git that could not answer and a tracker that refused a write —
    // and the second of those is a finding that may be filed twice, which is worth a line.
    for (const s of result.skipped) {
      if (!s.quiet) console.log(`[advocate] ${a.name}: ${s.id} — ${s.why}`);
    }
    if (!result.flagged.length && !result.unasked) return;

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const f of result.flagged) {
      emit(a, 'notinmain', {
        id: f.id,
        title: f.title,
        detail: `closed over ${f.branch}, which has ${f.ahead} commit${f.ahead === 1 ? '' : 's'} that never reached ${f.base} — filed ${f.card} and reopened nothing`,
      });
    }
  }

  /* --------------------------------------------------------------- the tick */

  async function tickOne(a, sessions) {
    a.error = null;
    a.quiet = o.respectQuietHours && isWorkspaceQuiet(cfg, a.name);

    const mine = sessions.filter((s) => s.workspace === a.name);
    await reconcile(a, mine);
    // After the reconcile, so a window this advocate is still holding is claimed by the
    // worker that owns it rather than swept out from under it.
    await sweepWindows(a, mine);
    // After both, which are what put things on the closing list, and before the
    // worktree sweep, which is happier once the window it wants to retire has gone.
    reapClosing(a, mine);
    // Before the sweep: the archive needs the worktree where the session left it.
    await archiveFinished(a);
    // Every live session, not just this repo's: a worktree is protected by whoever
    // is sitting in it, and `workspace` is null for a session outside any of them.
    await tidy(a, sessions);
    // Before the survey, and it makes no difference to the survey: a marked bead is out
    // of `bd ready` whether or not this has run. It is here because it is housekeeping
    // on the tracker like the two sweeps above it, and because the thing it produces —
    // a card — is not something the queue below is ever going to notice.
    await askSuperseded(a);
    // Also before the survey, and here it *does* make a difference to it: the `human`
    // label this writes is what keeps a bead whose branch already landed out of the queue
    // built two lines down. See `flagInMain`.
    await flagInMain(a);
    // And the same again, for work that has not landed but is already on a branch: this
    // one writes nothing at all and is read by the survey itself, so it has to have run
    // before the survey rather than merely before the launch. See `withoutOpenPrs`.
    await inflight(a);
    // And the same again, for the work nothing has written down anywhere yet: which
    // windows are open. Every live session and not just this repo's, for the reason
    // `tidy` above takes them all too. Set here rather than read inside the survey so
    // that all three surveys in a tick answer from one snapshot of the laptop, and so a
    // test can drive the filter by writing session records. See `withoutLiveSessions`.
    a.liveSessions = sessions;

    try {
      a.queue = await survey(a);
      a.lastSurveyAt = iso();
    } catch (err) {
      a.error = err.message.split('\n')[0];
      note(a, `cannot read the tracker — ${a.error}`, 'warn');
      return;
    }

    // Off the survey that has just run, and above the three lines that stop the tick, for
    // the reason `askSuperseded` and `flagInMain` are above them: this is housekeeping on
    // the tracker rather than something done to this Mac. An epic whose plan has all closed
    // is a feature in `main` that has not been through UAT, and pausing an advocate or
    // hitting quiet hours is not a reason for that to go unrecorded — no window opens, no
    // notification fires, and a paused workspace that says nothing about it for eight hours
    // is the one state where the record is worth most. `promote` itself refuses to run on an
    // observer instance, which is the one case where writing anything would be wrong.
    //
    // Deliberately off the *pre-`landed`* survey when `landed` is about to run: that survey
    // sees more beads open, so it under-files rather than over-files, and the next tick
    // catches what it missed. Filing a promotion for an epic whose work is not all in is the
    // one mistake here that a later tick cannot undo.
    await promote(a);

    // And the fourth sweep of the family, here rather than up with the other three
    // because it is the one whose writes cannot change the survey: the beads it reads are
    // closed, and the card it files is `human` from birth. Above the three lines that
    // stop the tick for the reason `promote` is — a paused advocate opens no windows and
    // this opens none, and a fortnight-old branch nobody has noticed is exactly the thing
    // a quiet night should still be finding. See `flagNotInMain`.
    await flagNotInMain(a);

    // Everything above this line is looking; everything below it is doing. An
    // observer instance stops exactly here — the survey has already run, so the
    // queue and what it would pick up next are on screen, which is the whole reason
    // to boot a second one. See OBSERVING in lib/config.js.
    if (OBSERVING) return note(a, `${OBSERVING_NOTE} · ${a.queue.length} ready`);
    if (a.paused) return note(a, `paused · ${a.queue.length} ready`);
    if (a.quiet) {
      const until = quietUntil(spaceFor(cfg, a.name));
      return note(a, `quiet${until ? ` until ${until.toISOString().slice(11, 16)}` : ''} — watching, not launching`);
    }

    // On the interval, and before anything is decided about the queue: a bead whose PR
    // merged on github.com is closed work that reads as ready work, and every number
    // below — the queue count on the card, what "next" says, whether this repo is at
    // its limit — is computed from a list that still has it in.
    if (a.queue.length && (await landed(a))) {
      try {
        a.queue = await survey(a);
      } catch (err) {
        a.error = err.message.split('\n')[0];
        note(a, `cannot read the tracker — ${a.error}`, 'warn');
        return;
      }
    }

    const free = a.limit - a.workers.length;
    const globalFree = globalLimit() - totalWorkers();
    let ready = candidates(a);

    // A queue emptied by the hierarchy filter is not a clear one, and saying "clear"
    // over it would be the loudest possible version of the bug this filter fixes: an
    // advocate reporting nothing to do, and then *proposing new work*, while an epic
    // sits there whose children are the entire reason it was skipped.
    const held = (a.heldByChildren || []).length;
    // And a fifth, which is the only one of them that will never resolve on its own: a
    // queue emptied because every bead left in it names a checkout nothing can place is
    // a queue waiting on one edit to a label or to the approved list, and an advocate
    // that said "clear" over it — and then proposed *more* work into the same workspace
    // — would be burying the one sentence that says what to fix.
    const unplaceable = (a.heldByRepo || []).length;
    // And the same argument for the twins: a queue emptied because every bead left in
    // it is a second copy of work already under way is not a clear queue, and an
    // advocate that said "clear" over one would go on to propose *more* work while a
    // duplicate of what it is already doing sat there unmentioned.
    const twins = (a.heldByTwin || []).length;
    // And the third, for the same argument a third time: a queue emptied because every
    // bead left in it is already on a branch is not a clear queue, and an advocate that
    // said "clear" over one would go on to propose new work while the old work sat in a
    // pull request nobody had merged.
    const inflightHeld = (a.heldByPr || []).length;
    // And the fourth, which is the loudest of them: a queue emptied because a window is
    // already open on every bead left in it is the opposite of a clear queue, and an
    // advocate that proposed new work over one would be filing beads beside sessions it
    // had forgotten it had.
    const sitting = (a.heldByLive || []).length;
    // And the fifth, which is the only one of them that is not about this laptop at all:
    // a queue emptied because another Mac has claimed every bead left in it is a queue
    // being worked, elsewhere. An advocate that reported "clear" over one and then
    // proposed new work would be filing beads beside a colleague's open windows — and
    // the person reading the card cannot see that machine's screen, which is exactly why
    // this one has to say so rather than merely be true. See lib/lease.js.
    const claimed = (a.heldByLease || []).length;
    // And the sixth, which is the only one of them that is not about the *bead* at all: a
    // queue emptied because another session is editing the files every bead left in it
    // would touch. It reads as the others do for the same reason — an advocate that said
    // "clear" over it, and then proposed new work, would be filing beads beside files it
    // could see were busy. See `withoutClaimedFiles`.
    const onBusyFiles = (a.heldByClaim || []).length;
    // And the seventh, which is the only one of them that no window closing and no merge
    // will ever clear: a queue emptied because nothing on the board has decided any of it.
    // It counts into `quiet` like the rest, and here that matters more than anywhere else
    // — the alternative is an advocate that refuses every bead in the tracker and then
    // proposes new ones beside them. See `withoutOrphans` and lib/underp0.js.
    const orphaned = (a.heldByNoP0 || []).length;
    if (!a.queue.length) {
      const heldNote = held ? ` · ${held} waiting on ${held === 1 ? 'its children' : 'their children'}` : '';
      const repoNoteText = unplaceable
        ? ` · ${unplaceable} naming no checkout this workspace can work in`
        : '';
      const twinNoteText = twins ? ` · ${twins} the same job as work already under way` : '';
      const prNoteText = inflightHeld ? ` · ${inflightHeld} already in an open pull request` : '';
      const liveNote = sitting ? ` · ${sitting} with a session already open on ${sitting === 1 ? 'it' : 'them'}` : '';
      const leaseNote = claimed ? ` · ${claimed} claimed by another Mac` : '';
      const claimNote = onBusyFiles
        ? ` · ${onBusyFiles} whose files another session is editing`
        : '';
      const orphanNote = orphaned ? ` · ${orphaned} with no P0 above ${orphaned === 1 ? 'it' : 'them'}` : '';
      const quiet =
        held || twins || inflightHeld || sitting || claimed || unplaceable || onBusyFiles || orphaned;
      note(
        a,
        a.workers.length
          ? `${a.workers.length} session(s) working, nothing else ready${repoNoteText}${heldNote}${twinNoteText}${prNoteText}${liveNote}${leaseNote}${claimNote}${orphanNote}`
          : `${quiet ? 'nothing ready' : 'clear — no ready beads'}${repoNoteText}${heldNote}${twinNoteText}${prNoteText}${liveNote}${leaseNote}${claimNote}${orphanNote}`
      );
      if (!a.workers.length && !quiet && o.propose) await propose(a);
      return;
    }
    if (free <= 0) return note(a, `${a.queue.length} ready · at its limit of ${a.limit} session(s)`);
    // `globalLimit()` and not `o.globalMaxWorkers`: the raw value is what the config
    // asked for and the clamped one is what `globalFree` was computed from, so quoting
    // the raw one would name a cap that is not the cap holding this repo up.
    if (globalFree <= 0) return note(a, `${a.queue.length} ready · held by globalMaxWorkers (${globalLimit()})`);
    if (!ready.length) {
      const settling = a.queue.length - ready.length;
      return note(a, `${a.queue.length} ready · ${settling} settling or already tried`);
    }
    if (secsSince(a.lastLaunchAt) < clampInt(o.launchCooldownSeconds, 0, 3600, DEFAULTS.launchCooldownSeconds)) {
      return note(a, `${ready.length} to pick up · cooling down since the last launch`);
    }

    // The last thing before a window opens, and the only unconditional call to it. The
    // interval above is a throttle on traffic; a launch is the moment the throttle is
    // not worth the risk, because being ten minutes late here is a whole session spent
    // proving that work already in `main` is already in `main`. One `gh pr list` against
    // twenty seconds of iTerm is not a cost worth economising on.
    if (await landed(a, { force: true })) {
      try {
        a.queue = await survey(a);
      } catch (err) {
        a.error = err.message.split('\n')[0];
        note(a, `cannot read the tracker — ${a.error}`, 'warn');
        return;
      }
      ready = candidates(a);
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on`);
    }

    // And the second unconditional read, for the same reason and one state earlier: a
    // pull request opened four minutes ago by a delivery that could not merge is work in
    // flight, its bead is back in `bd ready`, and the interval above would let a window
    // open on it. bc-utyr is what that costs — a worker briefed to merge, beside two
    // sessions briefed that the merge is not theirs to make.
    if (await inflight(a, { force: true })) {
      try {
        a.queue = await survey(a);
      } catch (err) {
        a.error = err.message.split('\n')[0];
        note(a, `cannot read the tracker — ${a.error}`, 'warn');
        return;
      }
      ready = candidates(a);
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on`);
    }

    // And the third, the cheapest and the last thing between a bead and a window: is
    // somebody already sitting in it. A file read rather than a `gh` call, so it is
    // unconditional without needing an interval to be excused from. See `resight`.
    if (resight(a, ready)) {
      try {
        a.queue = await survey(a);
      } catch (err) {
        a.error = err.message.split('\n')[0];
        note(a, `cannot read the tracker — ${a.error}`, 'warn');
        return;
      }
      ready = candidates(a);
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on`);
    }

    const slots = Math.min(free, globalFree, ready.length);
    note(a, `${a.queue.length} ready · opening ${slots} session(s)`);
    for (const bead of ready.slice(0, slots)) {
      try {
        await launch(a, bead);
      } catch (err) {
        // A bead held for endorsement is not a launch that failed, and it must cost no
        // attempt: `maxAttemptsPerBead` would retire it from the queue while it waited,
        // and endorsing it afterwards would not bring it back. It is also no reason to
        // stop looking at the rest of this tick's list, which iTerm refusing is. The
        // survey already keeps held beads out, so reaching here means that filter did
        // not — hence a note rather than silence, deduped so a broken filter does not
        // print every thirty seconds forever. See lib/endorse.js.
        if (err.unendorsed) {
          note(a, `${bead.id} is waiting for your endorsement — no session opened on it`, 'warn');
          continue;
        }
        a.error = err.message.split('\n')[0];
        a.attempts[bead.id] = (a.attempts[bead.id] || 0) + 1;
        console.error(`[advocate] ${a.name}: could not open a session on ${bead.id} — ${a.error}`);
        emit(a, 'failed', { id: bead.id, detail: a.error });
        break; // If iTerm refused once it will refuse again this tick.
      }
    }
    persist();
  }

  /**
   * Called by the poller, on the poll it already makes. An advocate has no clock:
   * the moment a bead becomes ready is a moment the daemon is already looking.
   */
  async function tick() {
    if (!advocates.size || ticking) return;
    ticking = true;
    try {
      // One filesystem read for every advocate, so each is matched against the same
      // snapshot of what was running.
      const sessions = liveSessions(cfg);
      // Least-recently-launched first. A fixed order looks harmless until
      // `globalMaxWorkers` is the binding constraint: then whichever repo sits first
      // in the config takes every global slot on every tick and holds it until its
      // sessions end, and the others print "held by globalMaxWorkers" forever while
      // never being the one asked. An advocate that has never launched sorts first,
      // which is also the right answer for a repo that has just been added.
      //
      // Found by the Critic agent on bc-f98, arguing against raising maxWorkers.
      const order = [...advocates.values()].sort((x, y) =>
        String(x.lastLaunchAt || '').localeCompare(String(y.lastLaunchAt || ''))
      );
      for (const a of order) {
        try {
          await tickOne(a, sessions);
        } catch (err) {
          a.error = err.message.split('\n')[0];
          console.error(`[advocate] ${a.name}: ${a.error}`);
        }
      }
      persist();
    } finally {
      ticking = false;
    }
  }

  /* ------------------------------------------------------------------- API */

  const snapshot = () =>
    [...advocates.values()].map((a) => ({
      workspace: a.name,
      paused: a.paused,
      quiet: a.quiet,
      limit: a.limit,
      // What the stepper on the card may offer, and the cap it cannot argue with.
      // Both travel so the card never has to hardcode a number the daemon owns: a
      // button that offers 10, or that says nothing about a global cap of 3 holding
      // a limit of 5 down, is a control that misreports what pressing it did.
      ceiling: MAX_WORKERS_CEILING,
      globalMax: globalLimit(),
      globalHeld: a.limit > globalLimit(),
      queue: a.queue.length,
      // Only the top few travel: the card shows what it is about to pick up, and
      // the whole list is a `bd ready` away in the graph.
      // Without the two fields only the launch wants: `labels` is a whole array per row
      // and `repoProblem` is null for everything that reached the queue at all.
      next: a.queue.slice(0, 3).map(({ labels, repoProblem, ...b }) => b),
      // Which of this workspace's checkouts the advocate is standing in when it has
      // more than one, so a card that says "climative" can also say which of forty
      // repos each of these numbers is about. Null everywhere else, and the card draws
      // nothing for a null.
      repos: multiRepo(cfg, a.name) ? repoList(cfg, a.name).repos.map((r) => r.name) : null,
      workers: a.workers.map((w) => ({
        id: w.id,
        // The other beads this window is holding, when it is a batch head. On the card
        // because one worker now stands for several beads: without it a batch of five
        // reads as a single bead's window, and the four that vanished from the queue
        // have nothing on screen accounting for where they went.
        batch: Array.isArray(w.batch) ? w.batch : [],
        // And which of an epic's planned groups this window is, when it is one — the same
        // argument as `batch` one line up, for the other way a worker stands for several
        // beads. Null for every window that is not part of a plan.
        group: w.group && w.group.name ? { epic: w.group.epic || null, name: w.group.name } : null,
        // A window that is planning rather than working, which the card needs to draw
        // differently for one reason: it will finish with its bead still open, and every
        // other worker that does that has given up.
        planning: Boolean(w.planning),
        title: w.title,
        at: w.at,
        // The checkout this window is open in. With N repos behind one workspace name,
        // "climative" no longer says where a window landed, and this row is the only
        // place it can.
        repo: w.repo || null,
        claimed: Boolean(w.claimed),
        ended: Boolean(w.ended),
        pid: w.pid || null,
        sessionStatus: w.sessionStatus || null,
        attempt: w.attempt || 1,
        // Whether this window can be spoken to at all, and what it last said. The
        // card needs all three: a worker with no handle is one Reclaim cannot ask
        // about, which is a different thing from one that has not answered yet.
        reachable: Boolean(w.term),
        asked: w.asked || null,
        checkedInAt: w.checkedInAt || null,
        checkinNote: w.checkinNote || '',
      })),
      // Windows whose session has finished — the bead closed, a pull request delivered,
      // the bead handed back — and whose process is still up, waiting to be
      // signalled. On the card because it is the one state where the advocate is
      // about to do something to a process, and a number that appears and clears
      // within a minute is how you tell it is working without reading the log.
      closing: a.closing.map((c) => ({ id: c.id, title: c.title, pid: c.pid, at: c.at, signalled: Boolean(c.sentAt) })),
      note: a.note,
      error: a.error,
      surveying: a.surveying,
      lastSurveyAt: a.lastSurveyAt,
      lastLaunchAt: a.lastLaunchAt,
      lastProposalAt: a.lastProposalAt,
      tidy: a.tidy,
      // What the last sweep for externally-merged work found. On the card for the same
      // reason `tidy` is: it is the daemon doing something to the tracker on its own,
      // and the only place that would otherwise show is a log nobody has open.
      landed: a.landed,
      // And the same again for the duplicates it handed over rather than worked. This
      // one is the more surprising of the two to find in a log — a bead moving into the
      // inbox on its own — so it belongs where the sweeps are read.
      superseded: a.superseded,
      // And the third of the family: the beads whose branch turned out to be in main
      // already. Same argument — a bead that moves itself into the inbox should be
      // legible from the card, not only from `~/Library/Logs/beadcause.log`.
      inMain: a.inMain,
      archive: a.lastArchive,
      pendingNotes: a.pendingNotes.length,
      deferredByPriority: a.deferredByPriority || 0,
      // With the reason attached, because "3 held" and "3 held, and here is which
      // three and why" are the difference between a number you trust and a number you
      // have to go and check against `bd ready` by hand.
      heldByChildren: (a.heldByChildren || []).map((h) => ({ id: h.id, why: h.why })),
      // The seventh, and the only one nothing but an edit will clear: a bead naming a
      // checkout that is not approved, not on disk, or shared with another repo. The
      // `why` is lib/repos.js's own sentence and it names the fix, which is why it has
      // to reach the card rather than only the log.
      heldByRepo: (a.heldByRepo || []).map((h) => ({ id: h.id, why: h.why })),
      // The fourth subtraction from `bd ready`, carried the same way and for the same
      // reason: a bead held because another one is the same job has to be visible as
      // held, or the advocate is silently doing less than the tracker says it could.
      heldByTwin: (a.heldByTwin || []).map((h) => ({ id: h.id, why: h.why })),
      // The fifth, and the only one that can be acted on from the phone that is reading
      // it: the pull request number travels so the card can send you to the board, where
      // the merge — or the conflict — is one tap. See lib/inflight.js.
      heldByPr: (a.heldByPr || []).map((h) => ({ id: h.id, why: h.why, number: h.number, url: h.url, repo: h.repo || null })),
      // The sixth, and the only one you can settle by closing a window: a bead held
      // because a session is already open on it. The pid travels because it is the whole
      // of the evidence — a held bead with no way to see which window is holding it is
      // the state bc-vq78 spent an hour in from the other side.
      heldByLive: (a.heldByLive || []).map((h) => ({ id: h.id, why: h.why, pid: h.pid || null })),
      // The seventh, and the only one about a machine that is not this one: a bead
      // another Mac has claimed in the shared tracker. The handle travels because it is
      // the only part you can act on — every other held pill names something on the
      // screen in front of you, and this one names a person to ask.
      heldByLease: (a.heldByLease || []).map((h) => ({ id: h.id, why: h.why, handle: h.handle })),
      // And the one that names a *file* rather than a bead, a window or a machine:
      // another session on this laptop is editing what this bead would touch. The
      // files travel because they are the whole of the evidence and the only part you can
      // check — a held bead whose pill would not say which file is a number nobody can
      // confirm. See lib/beadfiles.js.
      heldByClaim: (a.heldByClaim || []).map((h) => ({ id: h.id, why: h.why, files: h.files, branch: h.branch, source: h.source })),
      // And the one that is about no contention at all: a bead nothing has decided should
      // happen. It carries only the id and the sentence, because unlike every other hold
      // here there is no second party to name — no window, no branch, no machine, no file.
      // The fix is on the bead itself, and the sheet is where it is offered (bc-rfnr.7).
      heldByNoP0: (a.heldByNoP0 || []).map((h) => ({ id: h.id, why: h.why })),
      // And its near miss: the same collision, on a surface this daemon guessed rather than
      // one the bead declared, so the window was opened anyway (bc-hrno). Not a hold, and
      // it must not be shown as one — it is the evidence for or against ever turning
      // `holdGuessedFiles` on, which is a judgement nobody can make from an empty screen.
      filesBusy: (a.filesBusy || []).map((h) => ({ id: h.id, why: h.why, files: h.files, branch: h.branch })),
      // And the windows this advocate gave up because another Mac's claim won. Not a
      // subtraction from the queue but the same argument one step later: a session
      // withdrawn with nothing on screen reads exactly like one that finished, and the
      // whole of lib/lease.js's contract is that the machine which lost says so.
      stoodDown: (a.stoodDown || []).map((s) => ({ id: s.id, title: s.title, why: s.why, handle: s.handle, at: s.at })),
      // And what the last read of GitHub's open pull requests found, carried for the
      // reason `landed` is: a subtraction nobody can see is indistinguishable from an
      // advocate that has decided there is nothing to do.
      inflight: a.inflight,
    }));

  /**
   * Ask every open session whether it is still working, and free the slots of the
   * ones that are not there to answer.
   *
   * This is what the button used to do badly. `release` assumed: it emptied the slot
   * list on the strength of you having pressed it, so a session that was three hours
   * into a bead lost its slot to the next launch, and one whose window you had closed
   * looked exactly the same. Nothing was ever asked, because there was nothing to ask
   * with — an iTerm window is not a socket, and the daemon owns neither the window nor
   * the shell inside it.
   *
   * Now there is: the session id captured at launch, and `write text` into it. Three
   * outcomes per worker, and each is a fact rather than an assumption:
   *
   * - **the window is gone** — the id addresses nothing, so the slot is free, proven;
   * - **the window answers** — the message lands in the TUI, the slot is *held*, and
   *   the session has `checkinMinutes` to run the check-in command or finish the way
   *   its brief says to. Both endings already existed; this only asks for one of them;
   * - **iTerm will not talk to us** — the slot is held. A refusal from macOS is not
   *   evidence about the session, and treating it as such would take a slot away from
   *   an agent that is working.
   *
   * The waiting happens in `reconcile`, not here: the answer arrives minutes later,
   * from a process that may outlive this request, so the only durable place to notice
   * it is the tick that is already looking at every worker.
   */
  async function reclaim(a) {
    const minutes = clampInt(o.checkinMinutes, 1, 240, DEFAULTS.checkinMinutes);
    const kept = [];
    let asked = 0;
    let freed = 0;
    let unreachable = 0;
    for (const w of a.workers) {
      if (!w.term) {
        // Launched before the window id was recorded — nothing to address. Take the
        // word of whoever pressed the button, which is all the old button ever had.
        finish(a, w, 'no window was recorded for it — the slot was freed without asking', 'reclaimed');
        freed += 1;
        continue;
      }
      let answer;
      try {
        answer = await say(w.term, checkinMessage(a.name, w.id, minutes));
      } catch (err) {
        console.error(`[advocate] ${a.name}: could not reach ${w.id}'s window — ${err.message}`);
        unreachable += 1;
        kept.push(w);
        continue;
      }
      if (answer === 'missing') {
        finish(a, w, 'its window is gone — the slot is free', 'reclaimed');
        freed += 1;
        continue;
      }
      // A check-in from before the question cannot answer it, and leaving it in place
      // would let a session that has since hung look like one that just replied.
      clearCheckin(a.name, w.id);
      w.asked = iso();
      w.checkedInAt = null;
      w.checkinNote = '';
      kept.push(w);
      asked += 1;
    }
    a.workers = kept;
    const detail = [
      asked ? `asked ${asked}` : '',
      freed ? `freed ${freed}` : '',
      unreachable ? `${unreachable} unreachable` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'nothing to reclaim';
    console.log(`[advocate] ${a.name}: reclaim — ${detail}`);
    emit(a, 'reclaimed', { detail });
    return { asked, freed, unreachable };
  }

  async function control(name, action, value) {
    const a = advocates.get(name);
    if (!a) throw Object.assign(new Error(`no advocate for ${name}`), { status: 404 });
    if (action === 'pause') {
      a.paused = true;
      a.note = '';
      console.log(`[advocate] ${name}: paused`);
      emit(a, 'paused', { detail: 'paused from the app' });
    } else if (action === 'resume') {
      a.paused = false;
      a.note = '';
      console.log(`[advocate] ${name}: resumed`);
      emit(a, 'resumed', { detail: 'resumed from the app' });
    } else if (action === 'reclaim' || action === 'release') {
      // `release` is still accepted, and has to be: public/sw.js serves these pages
      // from a cache, so a phone that has not reloaded is still sending the old word
      // for it. Same button, and now it asks before it takes anything.
      await reclaim(a);
    } else if (action === 'forget') {
      // Clears the attempt counters, so beads it gave up on are eligible again.
      a.attempts = {};
      emit(a, 'forgot', { detail: 'attempt counters cleared' });
    } else if (action === 'limit') {
      // How many sessions this advocate may open, changed while it runs. `a.limit` is
      // what `tickOne` reads, so setting it here is the whole of the live half —
      // the next tick, thirty seconds away, already uses the new number and no
      // restart is involved.
      //
      // Out of range is clamped, for the reason `workerLimit` clamps: a stepper that
      // errors on 10 is worse than one that stops at 9, and the number that comes back
      // in the snapshot is the number now in force. *Not a number at all* is refused,
      // which is a different thing and must not be quietly folded into the same path —
      // `Number(null)` is 0, so a request that forgot its value would clamp to 1 and
      // read as a deliberate "one session at a time" nobody asked for.
      const asked = typeof value === 'string' ? value.trim() : value;
      if (asked === '' || asked == null || !Number.isFinite(Number(asked))) {
        throw Object.assign(new Error(`limit needs a number, got ${JSON.stringify(value) ?? typeof value}`), {
          status: 400,
        });
      }
      const next = clampInt(asked, 1, MAX_WORKERS_CEILING, a.limit);
      a.limit = next;
      // The chip and the note both quote the limit, so a stale one would contradict
      // the number you just pressed until the next tick rewrote it.
      a.note = '';
      // And the persisted half, so a `launchctl kickstart` does not undo it. The
      // config object is the daemon's own — the server handed it in — so the write
      // and the in-memory view stay one thing.
      const saved = saveWorkerLimit(cfg, name, next);
      o.maxWorkersLimit = saved.maxWorkersLimit;
      console.log(`[advocate] ${name}: limit set to ${next} session(s)`);
      emit(a, 'limit', { detail: `limit set to ${next} session(s)` });
    } else {
      throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 });
    }
    persist();
    return a;
  }

  /**
   * The numbers that belong to no repo — what the console's global row is drawn from.
   *
   * `live` is counted here rather than on the page because the page is filtered by
   * space and this cap is not: a total taken over the three advocates you happen to be
   * looking at would read as headroom that does not exist.
   */
  const globals = () => ({ maxWorkers: globalLimit(), ceiling: GLOBAL_WORKERS_CEILING, live: totalWorkers() });

  return {
    tick,
    snapshot,
    control,
    globals,
    setGlobalLimit,
    has: (name) => advocates.has(name),
    get size() {
      return advocates.size;
    },
    /** For the log endpoint: where the survey agent's transcript lives. */
    logKey: (name) => `${name}/advocate`,
  };
}

/* ------------------------------------------------------------------ prompts */

/**
 * `repoBrief` is tier 3 (lib/agentrepo.js) and is empty on most installs and on every
 * run of the `off` setting — an unset affordance has to read as one that does not exist,
 * not as a heading with nothing under it.
 *
 * It goes after the memory brief and before the reflection, which is where it belongs in
 * both directions: the agent should have read what it *knows* before being handed
 * somewhere with nothing decided about it, and the reflection stays last so that the
 * question "was there something you could not do" is the most recent thing in context.
 */
function surveyPrompt(workspace, o, reflection = '', owner = ownerName(), repoBrief = '', wiki = '', checkouts = '') {
  return `You are the **${workspace} advocate** in beadcause. Your queue is empty: there is
no ready work left in this repo's beads tracker, and your job is to decide whether
that is genuinely finished or merely untracked.
${checkouts ? `\n${checkouts}` : ''}
You are running read-only. You can read the repo, read git history, and look things up
on the web (see below). Your \`bd\` is the read-only half, named verb by verb:
\`bd list\`, \`bd show\`, \`bd ready\`, \`bd blocked\`, \`bd search\`, \`bd comments\`,
\`bd stats\`, \`bd dep tree\`. Anything that would write — \`create\`, \`close\`,
\`update\`, \`delete\`, \`dep add\` — is denied by your allowlist, not merely discouraged,
and attempting one is a wasted round trip. If a *read* you genuinely needed was refused,
that is worth saying plainly rather than working around.
You cannot edit anything, and **you must not create any beads** — ${owner} approves
every bead before it exists. Your entire output is a proposal for them to accept or
reject.

**The one exception is labelling, and it has a narrow purpose.** You may run
\`bd label add <id> <label>\`, and \`bd label list <id>\` / \`bd label list-all\` to see
which labels this graph already uses — read those before you invent a label, because a
graph with six spellings of one tag is worse than one with none. What labelling is *for*
is routing a bead that already exists: above all \`bd label add <id> human\`, which puts
it in ${owner}'s inbox and is the cheapest way for a survey to say "this one needs you"
about work already tracked. It is **not** a way to edit beads. You cannot remove a label
or propagate one, and you must not use \`label add\` to reclassify, re-scope or annotate
somebody else's bead — that is what a proposal, or a comment on the bead, is for. If you
label something, say in your reply which bead and why.

**Look first, in roughly this order:**

1. \`bd list --status=closed --limit 20\` and \`git log --oneline -30\` — what has just
   been finished, and what does finishing it obviously leave undone?
2. \`bd list --status=blocked\` and \`bd blocked\` — is something stuck on a decision
   or a missing piece that deserves its own bead?
3. Comments on recent beads, especially anything under a \`## Discovered\` heading:
   sessions are told to write work they find there rather than filing it themselves.
   **That is the highest-value thing on this list** — it is real work, found by
   someone who was in the code, waiting for someone to ask about it.
4. The repo's own README/CLAUDE.md against what is actually there — a documented
   feature with no code, a rule with no enforcement.
5. \`grep -rn "TODO\\|FIXME" \` in the source, but only report ones that still make
   sense; most do not.

**What is worth proposing:** work that is real, specific, and would be obvious to
${owner} within one sentence of reading it. A bug you can point at. A half-finished
feature with a named gap. A test that does not test what it claims. Something a
recent commit clearly implies is next.

**What is not:** general tidying, "add more tests", "improve error handling",
speculative refactors, anything you would only know is needed by guessing at
intent, and anything already covered by an open bead — check \`bd list --status=open\`
before you propose. That last one is now checked for you: every title you propose is
compared against the live set, and a near-identical one arrives on ${owner}'s card
labelled as a duplicate of the bead it resembles. Which is a safety net and not a
substitute — a flagged row is a row that wasted the ask.

**Including about beadcause itself, and about you.** You run inside beadcause, and the
code that defines what you are and what you are asked is beadcause's own. When the thing
that needs changing is one of those — a field an amendment may not set, or the brief you
were handed above — a bead against the file that owns it is a legitimate proposal, and
the reflection section at the end of this prompt says which file that is. Same bar as
everything else. Say plainly in the description that the path is in beadcause's checkout,
because if this repo is not beadcause then whoever picks the bead up is somewhere else.

**It is completely fine to propose nothing.** An empty repo queue that is genuinely
finished should stay empty; a proposal filed to look busy costs ${owner} a decision and
buys nothing. If that is the answer, say so in one line and stop.

Otherwise finish your reply with a single fenced block, at most ${o.maxProposals} beads,
best first. Nothing after it:

\`\`\`beadproposal
workspace: ${workspace}
beads:
  - title: One line, imperative, specific
    type: task            # task | bug | feature | chore | epic | decision
    priority: 2           # 0 critical … 4 backlog
    complexity: medium    # low | medium | high — how hard the work is
    description: |
      Why this bead exists and what needs to be done. Write it for someone
      opening it cold in three weeks: name the files, name the symptom, say
      what the fix looks like. This is what a session will work from.
    acceptance: What has to be true for this to be closed.
    rationale: How you found it — the commit, the comment, the file.
\`\`\`

The description is the part that matters. A one-line bead is a bead someone has to
rediscover from scratch, and ${owner} is approving it on the strength of what you wrote.

\`complexity\` is the one field there that is not about what the work *is*. It is what
picks the model a session on this bead runs on — \`low\` and \`medium\` are for the cheap
fast one, \`high\` for the expensive one, and a bead that names no tier gets the expensive
one, because an unrated bead is an unknown bead. So rate the *work*, not how much it
matters: a one-file change with an obvious fix is \`low\` even when it is urgent, and
anything that turns on a design decision, spans several files that have to agree, or
needs a migration is \`high\`. You have just read the code, which is the last moment
anybody will know the answer this cheaply — leave the field off rather than guess.

${lookupBrief(owner)}

Use it sparingly here. Most of what makes a proposal good is inside the repo, and a
survey that goes reading the web is usually a survey that has run out of real work to
find. It earns its place when the repo's own claims turn on something outside it — an
upstream that has moved, a spec the code half-implements, a dependency whose successor
already shipped.
${wiki ? `\n${wiki}\n` : ''}
${memoryBrief(owner)}

You are the agent this matters most to: you survey the same repo again and again, and
"I proposed this and it was declined" is not something the tracker will tell you —
a declined proposal leaves no bead behind. \`recall\` before you propose, and
\`remember\` what ${owner} turned down and why. \`post\` on a topic when it is the *other*
advocates who need to know.

${repoBrief}
${reflection}`;
}
