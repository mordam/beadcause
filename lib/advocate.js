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
// `loadState`/`saveState` are aliased because this file has a pair of its own, over
// `advocates.json` — the roster, the slots, the attempt counters. The app's `state.json`
// is a different file with different owners (the inbox writes it, the console reads it),
// and the park register lives there rather than in the roster for one reason: a window
// outlives the advocate that opened it, and the console has to be able to list every
// parked conversation on this Mac without asking six advocates what they remember.
import {
  CONFIG_DIR,
  OBSERVING,
  OBSERVING_NOTE,
  saveConfig,
  loadState as loadAppState,
  saveState as saveAppState,
} from './config.js';
import { writeJsonAtomic } from './atomic.js';
import { CARD_LABEL } from './card.js';
import { snapshot } from './commonrepo.js';
import { QUEUE_EXCLUDED } from './endorse.js';
import { hasRootAbove, NO_ROOT_ABOVE } from './underroot.js';
import { homeIn } from './homing.js';
import {
  checkinMessage,
  messageSession,
  // The nightly window's own notice — deliberately neither `checkinMessage` nor
  // `pauseMessage`; the header there says why a third one had to exist.
  maintenanceMessage,
  pauseMessage,
  openEpicAdvocateSession,
  openPlanSession,
  openWorkSession,
  resolveSessionDir,
  // The launch that never happened, read off the temp files the launch itself minted.
  // Both are pure functions of three paths, so `reconcile` can ask the question without
  // a process to watch and without iTerm being involved at all. See `launchProgress`.
  discardLaunchFiles,
  launchProgress,
} from './session.js';
import { listTerminals } from './terminal.js';
import {
  dispatchable,
  formatPlan,
  isUnder as underEpic,
  isWholeJob,
  PLANNED_LABEL,
  PROMOTED_LABEL,
  readPlan,
  unplanned,
  WHOLE_LABEL,
} from './plan.js';
// The walk `underEpic` uses, imported for the one place that needs the *distance* rather
// than the yes/no: `leaseHolderBelow` names the nearest claim under a bead, and an adopted
// child's id cannot say how far down it is. Aliased because this file has an `ancestorsOf`
// of its own, and the two answer deliberately different questions — see it.
import { ancestorsOf as graphAncestors } from './ancestry.js';
// bc-jvt0.4: an owned childless epic is held until its advocate has decided, and "owned" is
// what tells the hold from a freeze — an unowned epic has no advocate to decide, so holding
// it would be holding it for ever. See `heldByChildren`.
import { ownerOf } from './ownership.js';
import {
  advocatedRoots,
  workerHolds,
  reentryFor,
  waitingOnMerge,
  waitingOnMergeCard,
  REENTER_DEFAULTS,
} from './reenter.js';
import {
  ADVOCATE_LABEL,
  advocateSession,
  isAssigned,
  isEnrolled,
  isPaused,
  openedRecently,
  PAUSED_LABEL,
  pausedEpics,
  rememberAdvocateOpened,
} from './epicadvocate.js';
import { filePromotion } from './promote.js';
// The base branch these sweeps ask their "did it reach main?" questions against — the
// workspace's own if it has one, and `pr.base` for everyone else. Deliberately
// `configuredBase` rather than `baseFor`: these four still resolve the *setting* for a
// workspace and do not ask GitHub per repo, which is bc-lde0's half and not this one's.
import { configuredBase } from './prbase.js';
import { beadToken, multiRepo, repoKey, repoList, resolveRepo } from './repos.js';
// The relay's first say in *dispatch* rather than in a brief (bc-ogicx.6). Both halves of
// the rule live over there, beside the file the ceiling is declared in: this file asks what
// a bead's department is and which candidates that leaves, and holds nothing else about
// relays. It is the only import in either direction — lib/relaydefs.js knows nothing about
// an advocate, a queue or a window, which is what lets `withinCapacity` be argued with in a
// test that has no tracker in it.
import { departmentsFor, withinCapacity } from './relaydefs.js';
import { liveSessions, liveProcessLines, linesNameBead, isWorkerLine, workspaceFor } from './claude.js';
// The other population of unattended windows on this Mac, and the whole of bc-29b3: a
// resolver is a Claude Code session in an iTerm window running this repo's own gate,
// which is what a worker is, so `globalMaxWorkers` is a lie unless it counts both. One
// direction only — lib/resolvers.js is told about *this* file through a hook the daemon
// wires, because importing back would be a cycle.
import { list as liveResolvers, maxLive as maxResolvers, pending as queuedResolvers } from './resolvers.js';
import { isWorkspaceQuiet, spaceFor, quietUntil } from './spaces.js';
// The nightly window: stop dispatching, empty the Mac, collect the Dolt store, resume.
// It owns its own numbers and the whole argument for each of them — including why the
// collection is `--skip-decay` and why the window always ends.
import {
  MAINTENANCE_DEFAULTS,
  collect as collectStores,
  decide as decideMaintenance,
  describe as describeMaintenance,
  holdsDispatch,
} from './maintenance.js';
import { setActivity, clearActivity } from './activity.js';
import * as agentlog from './agentlog.js';
// Never `agentlog.reset` directly — see the note on it. A survey's log is the only record
// of what the advocate saw, and clearing it without archiving is bc-eqn1.7.
import { archiveAndReset } from './agentarchive.js';
import { parseProposal, proposalBody, proposalTitle, dupeNote } from './proposal.js';
import { annotateDuplicates, findDuplicate, liveCandidates } from './dupe.js';
import { sweepWorktrees, describeSweep, expireRetired, describeExpiry, slimAttic, describeSlim } from './tidy.js';
import { reconcileLanded, describeLanded, describeTruncation } from './landed.js';
import { readOwed } from './owed.js';
import { landedNewsEvents, mutedNews } from './news.js';
import { markMerged as markWindowMerged } from './retitle.js';
import { openWork, inflightWhy, describeInflight } from './inflight.js';
import * as claims from './claims.js';
import { busyWhy, collides, declaredFiles, describeOverlap, occupiedBy, overlap, surfaceOf } from './beadfiles.js';
import { sweepSuperseded, describeSuperseded } from './superseded.js';
import { sweepFarBlocks, describeFarBlocks } from './farblock.js';
import { sweepFinishedEpics, describeFinishedEpics, sweepWholeEpics, describeWholeEpics } from './finishedepic.js';
import { sweepInMain, describeInMain } from './inmain.js';
import { sweepNotInMain, describeNotInMain, followNotInMain, describeFollowNotInMain } from './notinmain.js';
import { archiveSession, mergeCommitFor, noteMerge, mainCheckout, ranFactsOf, salvageNote } from './sessionlog.js';
// What the window actually ran on, once it has stopped — the outcome half of bc-nc6o,
// where lib/complexity.js above is the plan half.
import { ranUpdate, ranDiverged } from './ranmodel.js';
// And what the hour cost, which is the other half of the same write — bc-nc6o.8.
import { ctxUpdate, sessionTokens, tokenLine } from './sessiontokens.js';
import { corpusDir, loadCorpus } from './requirements.js';
import { markForGlean, recordLanding } from './reqlanding.js';
import { recordControlLanding } from './controllanding.js';
import { effective, claudeArgs, promptArgs, agentEnv } from './foundation.js';
import { memoryBrief } from './memory.js';
import * as agentrepo from './agentrepo.js';
import { lookupBrief } from './lookup.js';
// Empty on every install that has not named a readable space — see lib/confluence.js.
import { confluenceBrief } from './confluence.js';
import { ownerName } from './owner.js';
// The roster, and only the roster: `wantsAdvocate` reaches this file through
// lib/session.js's door, which is where a *launch* is refused. This is the other
// question — which epics have an advocate at all — and it is asked of the graph.
import { assignedAdvocates } from './epicadvocate.js';
import * as amendment from './amendment.js';
import { cardsForDelivery, DELIVERY_LABEL } from './delivery.js';
// The other half of the same question. Since bc-r941 a worker that delivers files a
// *merge-bead* and stops; the `pr-delivery` card above is what the merge queue raises
// later, when it has given up and the merge is Adam's. `deliveryFor` has to know both
// spellings of "this worker delivered", and knowing only the older one is bc-2uj4.5.4.
import { MERGE_LABEL, openMergeBeadFor } from './mergebead.js';
import {
  beadInName,
  closeNeverStartedWindow,
  closingFor,
  closingNeverStartedFor,
  decide,
  namesBead,
  saidFinished,
  signal,
  sweepCandidate,
  sweepingFor,
  REAP_DEFAULTS,
} from './reap.js';
// The frames iTerm forgot to close when their last tab went away. Nothing to do with the
// signal above it — there is no session to signal — which is why it comes from the module
// that owns the windows rather than from the one that owns the closing list.
import { closeEmptyWindows, unreportedStuck } from './iterm.js';
// The park-and-resume loop (bc-2uj4.5). `parked.js` is the two stores and the decision
// about when a window has stopped having anything to say; `resume.js` is what brings the
// conversation back. The app's own state file is where both live, so the console and the
// daemon read one answer — see the note on `parked` in lib/config.js.
import {
  adoptStrays,
  beadKey,
  dropOpen,
  dropPark,
  countResume,
  openList,
  parkDecision,
  parkedAt,
  parkedList,
  prKey,
  prunePark,
  recordPark,
  sessionKey,
  PARK_DEFAULTS,
} from './parked.js';
import { interruptedPrompt, prepareResume, resumePrompt } from './resume.js';
import { answeredBefore } from './answered.js';
import {
  describeLease,
  handleFor,
  isLive,
  leaseLabel,
  leaseVerdict,
  leasesOf,
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

/**
 * How many EpicAdvocate windows one workspace may have open — its own ceiling, and
 * deliberately not `MAX_WORKERS_CEILING`.
 *
 * The two numbers ration different things. `maxWorkers` rations *coding* windows, each
 * of which holds a branch and a worktree and can conflict with its neighbours;
 * `maxEpicAdvocates` rations *planning* windows, which write a document on an epic and
 * touch no code. Adam's decision, 2026-08-13: the worker limit must not affect how many
 * EpicAdvocates there are. Sharing a ceiling would reintroduce that coupling by the back
 * door the first time anyone raised one of them.
 */
export const MAX_EPIC_ADVOCATES_CEILING = 9;

const DEFAULTS = {
  enabled: true,
  workspaces: [],
  maxWorkers: 1,
  maxWorkersLimit: 3,
  // The EpicAdvocate budget, and the whole of its relationship to the numbers above it:
  // there isn't one. A planner is not rationed against `maxWorkers`, and it is not
  // rationed against `globalMaxWorkers` either — an advocate for an epic is the cheap
  // half of this system and the half that decides what the expensive half does, so
  // starving it to open one more coding window is the wrong trade in both directions.
  //
  // Three rather than unbounded, which is what "the worker limit does not affect the
  // number of EpicAdvocates" would mean read literally: twenty open epics on this repo
  // alone on the day this was written, and twenty iTerm windows is not a plan. Every
  // assigned epic still gets its card on the console; three of them have a window at
  // a time and the rest say they are waiting for a slot, which is a queue you can see
  // rather than a cap you cannot.
  maxEpicAdvocates: 3,
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
  /**
   * How long a window has to be missing before "we cannot see it" becomes "it is gone".
   *
   * **Three minutes, and the number is entirely about not being wrong.** The evidence is
   * the absence of a row in Claude Code's live-session list, which is the weakest kind of
   * evidence in this file: it is an absence, it is read off files another process writes,
   * and a reader that hiccups for one tick would otherwise declare a working agent dead,
   * free its slot, force its claim off and hand its bead to a second window — which is
   * bc-vq78, the worst failure here. One tick's absence is an observation. Six consecutive
   * ticks of it, over three minutes, with the reader demonstrably working because it can
   * still see *other* sessions, is a fact.
   *
   * It is deliberately much shorter than `workerTimeoutMinutes`, and that gap is the point
   * of the whole clock. Before this existed a window closed by hand kept its slot for two
   * hours and was then charged an attempt, so the conversation was thrown away, the bead
   * was punished for it, and the Mac ran one window short the whole time. Three minutes
   * turns all three of those around.
   *
   * `0` or `false` switches the detection off, and the endings below it — silent, timeout,
   * lapsed — go back to being the only ones, exactly as before.
   */
  goneMinutes: 3,
  // How long a window is given to get past line 3 of its command before the daemon
  // reads the temp files and concludes it never started. Seconds and not minutes,
  // because the whole value of the probe is that it answers before the two hours above
  // it — but not milliseconds either: what is being waited out is `~/.zshrc`, and on the
  // Mac this was measured on that is nvm and pnpm and a minute's worth of nothing in
  // particular. 45 leaves a lot of room over the ~6s an ordinary shell here takes, and
  // being wrong the *early* way costs a live window its slot, which is much worse than
  // waiting another tick. `0` or `false` switches the probe off; see `reconcile`.
  neverStartedSeconds: 45,
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
  // Clear a bead marked `blocked-by:` a bead in another tracker, once that far bead
  // closes — see lib/farblock.js. On by default for the same reason as the sweep above,
  // and the fix is stronger here: unlike a `superseded-by:` marker there is no question
  // to ask, so leaving this off would mean a cross-tracker block never comes off on its
  // own once the thing it was waiting on has actually landed.
  clearFarBlocked: true,
  // One `bd ready --json` per repo, this far apart, for `supersededIntervalMinutes`'s
  // exact reason: the event this is watching for — a far bead closing — happens rarely,
  // and there is no label to narrow the query with.
  farBlockedIntervalMinutes: 10,
  // Ask about an epic that is finished — see lib/finishedepic.js. On by default for
  // bc-xl7n.74's reason: the failure it fixes is a worker window opened on an epic with no
  // diff left to deliver, whose only honest ending is a hand-written card — this offers
  // the same card for free, before the window ever opens.
  //
  // **One switch over two questions**, and deliberately: "every child closed" and "worked
  // as one job, and that work is in main" (bc-jvt0.5) are two ways of establishing the same
  // finding about the same kind of bead, and they emit the same card. A second flag would
  // be a way to turn half of it off with no reason anybody could give for wanting to.
  flagFinishedEpics: true,
  // One `bd ready --json` per repo plus one `bd list --parent` per epic it finds, and one
  // `bd list --label whole-job` for the second question, this far apart. An epic finishing
  // is not an event anything else here watches for, so the same ten minutes as the sweep
  // above is cheap relative to how rarely the answer changes.
  finishedEpicIntervalMinutes: 10,
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
  // Defer a bead to the next tick when another bead *this same tick is about to open* has
  // declared an intersecting surface — see `withoutCollidingSiblings` and bc-42ow.4. On by
  // default, and separable from `holdClaimedFiles` above because it is a different question
  // with different evidence: that one is bead-versus-live-claim and this one is
  // bead-versus-bead, which is the only file collision no register can see, because at the
  // moment it is decided neither window exists. Declared surfaces only, whatever
  // `holdGuessedFiles` says — a hold with a guess at *both* ends has no evidence at either.
  holdCollidingSurfaces: true,
  // Hold a bead out of the queue while *another Mac* has claimed it, and stand down when
  // one claims it underneath us — see lib/lease.js, which owns the numbers because it
  // owns the argument for them. The fifth of the family above and the only one whose
  // evidence lives in the shared graph rather than on this laptop: the other four can
  // each see one machine's worth of the world, which is the whole of the problem once a
  // tracker is federated.
  ...LEASE_DEFAULTS,
  sessionLog: true,
  sessionTranscripts: false,
  // Tier 3 (bc-goo.6, lib/agentrepo.js): whether an agent is given a private repo of its
  // own, and which arm of the experiment each run is. `alternate` flips between `blind`
  // and `index` per workspace and agent, which is the only setting that produces a
  // comparison — and the comparison is the finding, not the repo. `off` withdraws the
  // whole affordance, including the write grant; `blind` and `index` pin an arm, which is
  // for reproducing something the log showed rather than for running it.
  //
  // It sits under `advocates` because the advocate was the first agent to have one, and
  // it stays there because a config key that moves breaks every install that set it. The
  // Epic Advocate and the worker read the same key through `agentrepo.armSetting` — the
  // value lives in lib/agentrepo.js now, because lib/session.js cannot import this module.
  agentRepo: agentrepo.ARM_SETTING,
  // Re-opening the Epic Advocate when something moves under an epic it has already been on —
  // see lib/reenter.js, which owns the numbers because the argument for each of them is
  // in its header. The half of bc-rfnr.3 that was filed as delivered and was not.
  ...REENTER_DEFAULTS,
  // Closing the window of a session whose bead is closed — see lib/reap.js, which
  // owns the numbers because it owns every decision they feed.
  ...REAP_DEFAULTS,
  // The nightly maintenance window — see lib/maintenance.js, which owns the numbers for
  // the same reason. Off by default, and that is the one default here worth pausing on:
  // every other sweep in this file reads something, and this one closes windows.
  ...MAINTENANCE_DEFAULTS,
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
 * How many EpicAdvocate windows this repo may have open — the twin of `workerLimit`,
 * and the point is that it is a twin rather than a share.
 *
 * Same per-workspace scoping and the same override key, so a repo that plans a lot can
 * say so without touching how many coding windows it opens. Nothing here reads
 * `maxWorkers`, `maxWorkersLimit` or `globalMaxWorkers`, and that absence is the
 * feature: a stepper on the worker limit must leave this number exactly where it was.
 */
export function epicAdvocateLimit(cfg, name) {
  const o = options(cfg);
  const want = o.perWorkspace?.[name]?.maxEpicAdvocates ?? o.maxEpicAdvocates;
  return {
    limit: clampInt(want, 0, MAX_EPIC_ADVOCATES_CEILING, DEFAULTS.maxEpicAdvocates),
    ceiling: MAX_EPIC_ADVOCATES_CEILING,
  };
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

/** The opt-in list as a list, whatever shape it was written in. `"*"` is a list of one. */
const wanted = (o) => (o.workspaces === '*' ? ['*'] : Array.isArray(o.workspaces) ? o.workspaces : []);

/**
 * Why this workspace may not be switched on or off from the console — or `''`.
 *
 * Three settings can make the switch a lie, and each of them lives somewhere the
 * console cannot see, which is exactly why the reason travels rather than the button
 * being drawn and then refusing. `advocates.enabled` is the master off, so a repo added
 * to the list under it would sit there advocated-on-paper and never tick. `"*"` is the
 * opposite problem: every configured workspace is already in, and there is no list to
 * take one out of — expanding the star into a frozen list to make one Off button work
 * would silently stop every repo added afterwards from getting an advocate, which is
 * the one thing the star was chosen to say. And a space's `advocate: false` is a veto
 * over a group, deliberately above the per-repo switch: `advocatedWorkspaces` filters
 * on it last, so a workspace written into the list under one would still get nothing.
 */
export function switchBlocked(cfg, name) {
  const o = options(cfg);
  if (!o.enabled) return 'advocates.enabled is false in config.json — every advocate is off, whatever this list says';
  if (wanted(o).includes('*'))
    return 'advocates.workspaces is "*" — every configured workspace has one, and there is no list to take this out of';
  if (spaceFor(cfg, name)?.advocate === false)
    return `the ${spaceFor(cfg, name).name || 'space'} space has advocate: false, which vetoes every workspace in it`;
  return '';
}

/**
 * Add or remove one workspace from `advocates.workspaces`, so a restart still honours it.
 *
 * The third of the family with `saveWorkerLimit` and `saveGlobalWorkerLimit`, and the
 * only one that can refuse: the two limits are numbers with a clamp, and this is a
 * membership whose meaning depends on two other settings — see `switchBlocked`, which
 * is checked here rather than only at the call site so that no path can write a setting
 * that would not take effect.
 *
 * Always a fresh array, never a push. `options()` spreads the defaults, so a config with
 * no `workspaces` key at all hands back `DEFAULTS.workspaces` — the module-level array —
 * and pushing onto that would give every later reader in the process a workspace nobody
 * asked for, including one reading a different config object.
 */
export function saveAdvocated(cfg, name, on) {
  const blocked = switchBlocked(cfg, name);
  if (blocked) throw Object.assign(new Error(blocked), { status: 409 });
  const adv = cfg.advocates && typeof cfg.advocates === 'object' ? cfg.advocates : (cfg.advocates = {});
  const list = wanted(options(cfg)).filter((w) => w !== name);
  const next = on ? [...list, name] : list;
  adv.workspaces = next;
  saveConfig(cfg);
  return next;
}

/** Which workspaces have an advocate at all. `["*"]` means every configured one. */
export function advocatedWorkspaces(cfg) {
  const o = options(cfg);
  if (!o.enabled) return [];
  const want = wanted(o);
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

/**
 * Where the nightly window's state sits in `advocates.json`.
 *
 * The file is `{ [workspaceName]: {...} }` and is only ever read by explicit name
 * (`saved[ws.name]`), never enumerated, so one extra key costs nothing and collides with
 * nothing. `#` leads it because a workspace name is a directory name under `~/beads/`,
 * and this is the cheapest way to say "not one of those" to anybody reading the file.
 */
const MAINTENANCE_KEY = '#maintenance';

/** Highest priority first, then oldest — the order an advocate picks work up in. */
// createdAt is an ISO string at millisecond resolution: two beads filed in the same
// batch (a loop, a bulk file()) can share one, and without a tie-break the order
// between them falls through to whatever order bd.ready() happened to return —
// silently changing which bead the card shows as "next" or which gets a window
// opened on it this cycle (see the callers below). id is the tie-break.
const byPickOrder = (x, y) =>
  x.priority - y.priority ||
  String(x.createdAt).localeCompare(String(y.createdAt)) ||
  String(x.id).localeCompare(String(y.id));

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
 *
 * **And it is not, on its own, the question this file asks — bc-b2k.2.** `bd update <bead>
 * --parent=<epic>` moves the edge and renumbers nothing, so an *adopted* child keeps a flat
 * id and this answers no about a bead the tracker says is underneath. Every subtree
 * question here — the worker/epic overlap guards, batch membership, the queue holds, the
 * pause fan-out — goes through `underEpic` (lib/plan.js's `isUnder`) with this tick's parent
 * edges, so the id is the fallback rather than the answer. What is left for this one is the
 * *statement of the id fact*: it is what `ancestorsOf` below and `withoutPausedEpics` lean
 * on where a graph is deliberately not read, and what test/epicqueue.mjs pins the dot rule
 * against.
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
 * The mark a dispatched group leaves on the epic whose plan named it — bc-zjab.3.
 *
 * A planner files a plan, gets exit 0, and has no way to learn whether the daemon
 * dispatched its groups or ignored the plan and sent the children out one window each.
 * Measured on bc-y3qk: the plan said two groups, five windows opened two minutes later,
 * and every surface a planner can reach said it had worked — the `planned` label was on
 * the epic, the plan comment parsed and re-read correctly, the epic was open with no
 * assignee, and the children were `in_progress`, which is exactly what a dispatched group
 * looks like too. The only evidence that existed was the *wording* of a log line, which is
 * discoverable only by having seen both and noticed the contrast.
 *
 * So a group that dispatches says so on the bead, the way the epic already says `planned`.
 * One label per group, named after the group, so an epic ends up carrying the list of its
 * plan's groups that actually took a window — and a plan whose groups were ignored carries
 * `planned` and nothing else, which is the diagnosis rather than an absence to interpret.
 *
 * **Nothing in this daemon reads it, deliberately.** Dispatch is recomputed from the plan
 * and the queue on every tick (`dispatchable`), and what stops a second window inside one
 * group is `a.workers`, not this. If the label were consulted it would become state that
 * can be wrong — lost to a `bd` that would not answer, or to an edit from the phone, which
 * posts the label set the card is showing — and a lost mark would then stop work rather
 * than merely stop explaining it. It is a record for whoever reads the bead afterwards,
 * and a record is allowed to be incomplete in a way a decision is not. That is also why it
 * is not in `PROTECTED_LABELS` (lib/verdict.js) and why `planned` and `promoted` are not
 * either: all three are daemon-written markers whose loss costs an explanation, not work.
 *
 * The name is slugged rather than written through because a label is not free-form text:
 * bd splits a label on the comma (measured — it normalises nothing else), so a group
 * called "the brief, and the mark" would silently arrive as two labels. Group names are
 * unique within a plan, so the slug identifies the group; slugging is idempotent and `bd
 * label add` is too, so a group re-dispatched after its window ended re-stamps the same
 * label rather than growing a second one.
 */
export const DISPATCHED_PREFIX = 'dispatched:';

/** `"the review gate and the round cap"` → `dispatched:the-review-gate-and-the-round-cap`. */
export function dispatchLabel(groupName) {
  const slug = String(groupName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  // A group whose name is entirely punctuation still dispatched, and a bare `dispatched:`
  // would read as a broken label rather than as the fact it is recording.
  return `${DISPATCHED_PREFIX}${slug || 'group'}`;
}

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
export function createAdvocates(cfg, {
  bd,
  bus,
  say = messageSession,
  open = openWorkSession,
  openPlan = openPlanSession,
  prs = openWork,
  // The Epic Advocate, re-opened on child events by `reenter` below. The fourth door into
  // an unattended window and the third injectable of this shape — the default is THE REAL
  // ONE, which drives iTerm, so a suite whose fixture has an enrolled epic in it must stub
  // this or a test opens a window on Adam's Mac. See lib/reenter.js.
  openAdvocate = openEpicAdvocateSession,
  // The in-app terminals, which are the one kind of window on a bead that this daemon
  // owns outright rather than infers from a process table. Injected like the three above
  // it so a test can hand over a list without a pty. See `leaseHandOpened`.
  terminals = listTerminals,
  // The tidy-up of windows that have no session left in them — injectable for the reason
  // the spawners above are, one step milder: the real one drives iTerm through an Apple
  // event, so a suite that ticked would be asking the terminal on Adam's Mac a question
  // once a minute. It closes nothing that has a tab in it, so a suite that did run the
  // real one would take nothing away; the injection is about not talking to iTerm at all.
  sweepEmpty = closeEmptyWindows,
  // The closer for a window that opened and never ran its command (bc-xl7n.113.3) —
  // injected for the same reason `sweepEmpty` above it is: the real one drives iTerm
  // through an Apple event, and `closeNeverStartedWindow` already refuses to send one
  // inside a suite (`mayLaunch`), but a test that wants to assert on *what* it decided
  // rather than on the refusal needs to hand over its own answers. See `reapNeverStarted`.
  closeNeverStarted = closeNeverStartedWindow,
  // The session audit agent (lib/sessionaudit.js), nudged when a session's archive lands.
  // Injected rather than imported for the reason the four spawners above it are: the real
  // one starts a `claude -p`, and a suite that archived a session would otherwise put an
  // agent on this Mac. Null — the default — is an advocate that archives and audits
  // nothing, which is every install with `sessionAudit` off.
  audit = null,
  // The process-table read `resight` falls back to (bc-xl7n.114) — injected for the same
  // reason `terminals` above is: the real one is a live `ps` of this Mac, and a suite that
  // ticked would otherwise be asking it once a tick for a fact no fixture controls.
  psLines = liveProcessLines,
}) {
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

  /**
   * The nightly maintenance window — one for the daemon, not one per advocate.
   *
   * **Fleet-wide, and it has to be.** Every advocate's workspace is a different Dolt
   * store, so a per-advocate window would collect each one on its own schedule while the
   * others were still dispatching into theirs — and the sessions this daemon opens are
   * not partitioned by workspace on this Mac. They are twenty iTerm windows sharing one
   * laptop, and "empty the Mac" is not a thing one advocate can be responsible for.
   *
   * The two fields are the whole state, and both are persisted (see `persist`): `night`,
   * so a window runs once per night, and `phase`, so a restart mid-sequence resumes it
   * rather than starting it again. A `launchctl kickstart` at 03:20 into a 03:00 window
   * that re-asked every session to wrap up, or ran a second collection behind the first
   * one's gate lock, would be a restart undoing the night.
   */
  let maintenance = saved[MAINTENANCE_KEY] || { phase: 'idle', night: null, why: '' };

  /**
   * Is the window forcing windows shut *right now*? Read by `reapClosing`, per call.
   *
   * Deliberately not a latch. `closing` is the one phase in which lib/reap.js waives two
   * of its four guards, and the moment the phase is anything else — the collection
   * started, the bound was reached, tomorrow happened — the ordinary guards must be back
   * in force. A boolean set on entry and cleared on exit is a boolean that survives the
   * one exit path somebody forgets.
   */
  const maintenanceForcing = () => maintenance.phase === 'closing';

  /**
   * One advocate's whole in-memory state, from the config and whatever the last run of
   * this daemon wrote down about it.
   *
   * A function rather than the loop body it used to be, because a workspace can now be
   * given an advocate while the daemon runs — see `enable`. A second construction site
   * for this object is the kind of duplicate that goes wrong months later and quietly:
   * a field added to the boot path and forgotten on the switch path is an advocate that
   * behaves differently depending on how it came to exist, and every one of these fields
   * is read somewhere that would not say which of the two it was looking at.
   */
  function record(ws, prev = {}) {
    const { limit, ceiling, requested } = workerLimit(cfg, ws.name);
    if (requested > ceiling) {
      console.warn(
        `[advocate] ${ws.name}: maxWorkers ${requested} exceeds maxWorkersLimit ${ceiling} — using ${limit}`
      );
    }
    return {
      workspace: ws,
      name: ws.name,
      limit,
      // The EpicAdvocate budget, read at boot exactly as `limit` is and from a key of its
      // own. Not derived from `limit` anywhere, now or later: the whole requirement is
      // that stepping one leaves the other where it was.
      epicLimit: epicAdvocateLimit(cfg, ws.name).limit,
      // The roster: one entry per open, owned root in this workspace, rebuilt from the
      // graph on every tick. Not persisted, and that is deliberate — an epic that closed
      // while the daemon was down must not come back as an assignment on restart, which
      // is exactly what carrying this across would do.
      epicAdvocates: [],
      // Which of those epics are paused, by id. Derived from the label on each bead
      // every tick (`rosterFor`), so it is **not** persisted and must not be: the label
      // is the fact, this is a read of it, and a copy carried across a restart is the
      // one thing that could outlive somebody taking the label off. What it buys over
      // asking `isPaused` at each call site is the shape the queue filter needs — a
      // membership test against every ancestor of a ready bead — plus one tick of
      // responsiveness, because `control` writes into it the moment the button is
      // pressed rather than waiting for `bd.graph`'s minute-long cache to turn over.
      pausedEpics: new Set(),
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
      // Windows `finish` recorded as `never-started`, waiting on `reapNeverStarted` — see
      // `closingNeverStartedFor` in lib/reap.js for why they cannot share `closing`
      // above: there is no pid, so nothing here is ever matched against a session record,
      // only re-described through the term handle each time. Carried across a restart for
      // the same reason `closing` is: the window is still on screen either way.
      closingWindows: Array.isArray(prev.closingWindows) ? prev.closingWindows : [],
      attempts: prev.attempts || {},
      lastProposalAt: prev.lastProposalAt || null,
      lastLaunchAt: prev.lastLaunchAt || null,
      lastTidyAt: prev.lastTidyAt || null,
      // When the window sweep last looked. Persisted so a daemon restarted every few
      // minutes does not turn a 5-minute interval into a `bd show` per candidate per
      // boot — and null, on a first run, means it looks immediately.
      lastWindowSweepAt: prev.lastWindowSweepAt || null,
      // When the Epic Advocate re-entry sweep last looked, and what it saw under each
      // enrolled epic — `{ [epic]: { kids, stalls, stalled, at } }`. **Both persisted, and the
      // second one is what makes the feature safe across a restart**: the snapshot is what
      // "something moved" is measured against, so a daemon that forgot it would treat every
      // child of every enrolled epic as newly filed on the first sweep after every boot, and
      // beadcause is restarted by its own merges several times a day. `at` is the per-epic
      // cooldown clock, and losing that is the same bug wearing a different hat.
      lastReenterAt: prev.lastReenterAt || null,
      advocated: prev.advocated && typeof prev.advocated === 'object' ? prev.advocated : {},
      // Not carried across a restart, unlike the tidy sweep's clock: a daemon that has
      // just come up is exactly when a merge it never saw is most likely to be sitting
      // there, so the first tick asks GitHub rather than waiting out the interval.
      lastLandedAt: null,
      // Same reasoning, and it bites harder: a bead marked superseded while the daemon
      // was down is held out of every queue by a marker only this sweep can act on, so
      // waiting out an interval before the first look is ten minutes of a bead nobody
      // can see.
      lastSupersededAt: null,
      // Same reasoning again: a bead marked `blocked-by:` a far bead that closed while the
      // daemon was down is held out of every queue by a marker only this sweep clears.
      lastFarBlockedAt: null,
      // Same reasoning again: an epic whose last child closed while the daemon was down is
      // exactly the state a restart is most likely to find, since a restart usually
      // follows a merge that closed that very child.
      lastFinishedEpicAt: null,
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
      finishedEpic: null,
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
      // And the childless epics somebody owns that nobody has judged yet — bc-jvt0.4.
      // Beside `heldByChildren` because the same function answers both and separate from it
      // because the claims are opposite: every other hold in this record is a bead
      // something *else* is doing, and this is a bead nothing has decided. It clears when
      // the epic's advocate records one job or files children, and the reason is what says
      // so. See `heldByChildren` check 4.
      heldByUndecided: [],
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
      // And the ones held because the epic above them is paused. Not contention at all,
      // like `heldByNoRoot` below and unlike the rest: every other hold here is two things
      // wanting the same bead and this one is somebody having said stop. See
      // `withoutPausedEpics` and lib/epicadvocate.js.
      heldByPause: [],
      // And the ones another Mac has claimed in the shared tracker. The fifth, and the
      // only one whose evidence came over the network — every other filter here can see
      // exactly one machine's worth of the world. See `withoutLeases` and lib/lease.js.
      heldByLease: [],
      // And the ones held because another session on this Mac is editing the very files
      // they would touch. The sixth, and the only one whose evidence is neither about the
      // bead nor about a window but about a *file* — see `withoutClaimedFiles`.
      heldByClaim: [],
      // And the ones deferred because another bead *this same tick was about to open* had
      // declared an intersecting surface. The only hold here whose second party is neither
      // a running thing nor a record — the other bead has no window, no branch and no claim
      // yet, which is exactly why nothing else could see it. See `withoutCollidingSiblings`
      // and bc-42ow.4; it clears itself on the next tick with nothing to release.
      heldBySurface: [],
      // And the ones held because nothing on the board has decided they should happen:
      // not a root, and no root anywhere above them. The seventh, and the only one that is
      // not about contention at all — every other hold here is two things wanting the
      // same bead, a window, a branch or a file, and this one is a bead nobody put on
      // the board. See `withoutOrphans` and lib/underroot.js.
      heldByNoRoot: [],
      // And the ones whose merge-bead already closed with a merge, so `bd ready` would
      // hand them to a fresh session while the actual close is still retrying — bc-4r10.20:
      // a delivery's close can be refused (a blocker unrelated to this pull request) or can
      // throw for a reason `Bd.close` could not force past, and either way `lib/owed.js`
      // is already holding the record and retrying it every poll, ahead of this very tick.
      // Reading that ledger here is what stops a window opening on work that landed
      // minutes — or, on the incident this bead is named for, days — before the retry
      // caught up. Not about contention like the six above it, and not a judgement like
      // `heldByNoRoot`: it clears itself the moment `sweepOwed` lands the close, with
      // nothing here to press. See `withoutOwed` and lib/owed.js.
      heldByOwed: [],
      // And the newest, bc-ogicx.6: beads whose **department** has as many windows open as
      // its definition says it may have. The only hold here that a *repo* asked for — every
      // other one is this program's own arithmetic or another machine's claim, and this one
      // is a `capacity:` in a `.beadcause/relays.yaml` a pull request can change. That is
      // safe for exactly one reason and it is worth having written down here as well as
      // there: **a capacity can only ever subtract**. It is counted against windows
      // `maxWorkers` and `globalMaxWorkers` had already agreed to open, so a repo can slow
      // its own department down and can never speed it up.
      //
      // Not in the `quiet` block below with the ten that can empty the queue — like
      // `heldBySurface`, and for the same reason: this subtracts from `candidates`, not from
      // `a.queue`, so a tick with one is a tick that still has beads in its queue. Its
      // sentence goes on the lines that report a queue with nothing pickable in it and on
      // the line that says how many windows are opening. See `candidates`.
      heldByDept: [],
      // And, beside it, the checkouts whose own `.beadcause/relays.yaml` would not parse or
      // would not validate. **Never a hold** — that is the whole distinction, and bc-ogicx.5
      // made the same one at the launcher: a broken definition dispatches the bead exactly
      // as it does today, it just dispatches it without a relay. What was missing was
      // anybody saying so. `openWorkSession` carries it as far as `relayProblem` and
      // test/relaywiring.mjs pins that with "the problem dies inside the launcher"; this is
      // where it stops dying. One sentence on the tick note, one log line per spell, and no
      // `heldBy*` entry, because nothing is being held. See `candidates`.
      relayProblems: [],
      // And what has already been printed about each of those two, which is a different
      // question from what is true now and needs a different lifetime. The two lists above
      // are emptied at the top of every tick; these are not, so a department that stays full
      // for an hour is one log line rather than a hundred and twenty. Not on the card and
      // not in the snapshot — they are a record of what the log has said, and nothing else.
      saidDept: Array.isArray(prev.saidDept) ? prev.saidDept : [],
      saidRelayProblem: Array.isArray(prev.saidRelayProblem) ? prev.saidRelayProblem : [],
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
      // The claims this Mac holds on beads whose window this advocate never opened —
      // bead id → `{ lease, at }`, the label we wrote (null for a bead we looked at and
      // did not claim) and when we last looked. **In memory and never persisted**, for
      // the reason lib/resolvers.js keeps its handles that way: the record is a claim
      // about a window that is open *now*, and one that survived a restart would be a
      // claim about a window nothing here can still see. A restart re-reads the labels
      // and adopts its own back. See `leaseHandOpened`.
      handLeases: new Map(),
      // What the last open-PR read found, kept between reads because it is asked on an
      // interval rather than on every tick: bead id → the pull request carrying it.
      openPrs: new Map(),
      inflight: null,
      lastInflightAt: null,
      note: '',
      error: null,
      surveying: false,
      quiet: false,
      // Switched off from the console while it still had windows open — see `disable`.
      // Never persisted: the config file is where "this repo has no advocate" is
      // written down, and a second copy of the same fact in `advocates.json` is one
      // that can disagree with it.
      draining: false,
    };
  }

  for (const ws of advocatedWorkspaces(cfg)) advocates.set(ws.name, record(ws, saved[ws.name] || {}));

  function persist() {
    const out = {};
    for (const [name, a] of advocates) {
      out[name] = {
        paused: a.paused,
        workers: a.workers,
        closing: a.closing,
        closingWindows: a.closingWindows,
        attempts: a.attempts,
        lastProposalAt: a.lastProposalAt,
        lastLaunchAt: a.lastLaunchAt,
        lastTidyAt: a.lastTidyAt,
        lastWindowSweepAt: a.lastWindowSweepAt,
        lastReenterAt: a.lastReenterAt,
        advocated: a.advocated,
        lastArchive: a.lastArchive,
        pendingNotes: a.pendingNotes,
      };
    }
    // Not an advocate, and the one entry here that is about the daemon rather than about
    // a workspace. See MAINTENANCE_KEY.
    out[MAINTENANCE_KEY] = { phase: maintenance.phase, night: maintenance.night, why: maintenance.why || '' };
    saveState(out);
  }

  /**
   * The two populations, told apart by the one field that already distinguishes them.
   *
   * A planner and a worker are the same launch through two different briefs — see
   * `launch` — so they have always lived in one `a.workers` array, and every subtree
   * check in this file depends on that: `heldByChildren` reads it to hold a bead whose
   * epic is being planned, `batchesFor` reads it to refuse a second window in one
   * subtree, and lib/lease.js reads it to answer another Mac. Splitting the array would
   * have to teach all of them about a second list, and each one that was missed is a
   * duplicate window nobody notices for a day.
   *
   * So the arrays stay one and only the *rationing* is separated: `coders` is what
   * `maxWorkers` and `globalMaxWorkers` count, `planners` is what `maxEpicAdvocates`
   * counts, and neither number ever sees the other's list.
   */
  const codersOf = (a) => a.workers.filter((w) => !w.planning);
  const plannersOf = (a) => a.workers.filter((w) => w.planning);

  /**
   * Which epics in this workspace are paused, off the cached export.
   *
   * Split out of `rosterFor` because the two are read at different moments and only one
   * of them can afford to be late: the roster is drawn on a card and is allowed to be a
   * tick behind, and this is what the queue filter reads, which is not. It is also the
   * half that must survive a restart — the label is the fact, `a.pausedEpics` is a read
   * of it, and nothing about that read is persisted.
   *
   * Fails soft in the direction that keeps the pause: a graph that would not answer
   * leaves the previous set in place rather than emptying it. A tracker mid-write is a
   * passing state, and reading it as "nothing is paused" would dispatch under a stopped
   * epic on exactly the tick nobody could explain afterwards.
   */
  async function refreshPauses(a) {
    const beads = await tickBeads(a);
    if (beads) a.pausedEpics = pausedEpics(beads);
  }

  /**
   * The cached export, read **once per tick** and shared by everything in the tick that
   * wants any part of it — the rows, through `tickBeads`, and the parent edges, through
   * `tickParents`. Whole rather than one field, because those two used to be one call each
   * and the second one would have been a second export for the sake of a `.parents`.
   *
   * `rosterFor` has always paid for this read; `refreshPauses` wants the same rows, half a
   * tick earlier. A second `bd.graph` would very nearly be free — it is cached per
   * workspace for a minute, and this asks with `wait: false` — but "very nearly free" is
   * not the contract test/reenter.mjs holds, and it is the right contract: the number of
   * exports a tick costs is a thing this file is supposed to know, not a thing that
   * accretes one call site at a time.
   *
   * `undefined` means "not asked yet this tick" and `null` means "asked, and the tracker
   * would not answer" — two different states, and collapsing them would re-ask a failing
   * tracker once per consumer. `tickOne` clears it; the roster and the pause set are then
   * computed from one snapshot, which is also what stops the card and the queue disagreeing
   * about a pause within a single tick.
   */
  async function tickGraph(a) {
    if (a.tickGraph !== undefined) return a.tickGraph;
    try {
      a.tickGraph = (await bd.graph(a.workspace, { wait: false })) || null;
    } catch {
      // A tracker mid-write is a passing state. Both consumers keep what they had.
      a.tickGraph = null;
    }
    return a.tickGraph;
  }

  /** That snapshot's rows — `Map(id → row)`, and `null` for a tracker that would not answer. */
  async function tickBeads(a) {
    return (await tickGraph(a))?.beads || null;
  }

  /**
   * The same snapshot's parent edges — who is really under whom, as against who looks it
   * from their id. `underEpic` and `unplanned` both need this to see a bead that was
   * adopted in with `bd update --parent`; see lib/plan.js's `isUnder`.
   */
  async function tickParents(a) {
    return (await tickGraph(a))?.parents || null;
  }

  /**
   * The roster: which epics have an advocate, and what each one is doing about it.
   *
   * **Derived from the graph, never from the window list, and rebuilt whole every tick.**
   * That is the entire lifetime rule in one sentence: an advocate exists while its epic
   * is open and is gone when the epic closes — not when its window exits. A roster
   * accumulated by *adding* on launch and *removing* on exit would get both halves
   * backwards, and the drift would be invisible, because a stale entry looks exactly like
   * a live one.
   *
   * `bd.graph` is already cached per workspace for a minute and is deliberately never
   * built on a request path, so asking it every tick costs a filter over a Map that some
   * other reader has almost certainly already paid for. `wait: false` matters for the
   * same reason it does at every other call site: a cold cache returns nothing and warms
   * behind us, and one tick with an empty roster is better than a tick that blocks the
   * daemon for seven seconds.
   *
   * The window, when there is one, is found by bead id among the planners — an
   * EpicAdvocate window is launched *on* its epic, so its `id` is the epic's. Where there
   * is none, `why` says which of the two reasons it is: out of budget, or nothing about
   * this epic is ready to plan. Both are states you can act on; "no window" on its own is
   * not.
   *
   * **`assigned` — bc-r2b5.3.** `assignedAdvocates` is `wantsAdvocate`: every owned open
   * root, whether or not anything has ever run on it. That is right for the filter — an
   * unassigned root still needs a card, because the card is where the button to assign it
   * lives — but it means every entry here used to be drawn as "has an advocate", which
   * overstated what was actually being supervised by exactly the gap between
   * `wantsAdvocate` and `isEnrolled`: 22 roots against 10 carrying the enrolment record,
   * measured in this workspace on 2026-08-17. `isEnrolled` (label or waiting-on sentence)
   * is the cheap fact bc-r2b5.1 made available on the same row, so a caller can tell "this
   * epic could have an advocate" from "somebody has actually put one on it" without a
   * second read, and any count of "epics with an advocate" is of `assigned`, not of the
   * roster's length.
   */
  async function rosterFor(a) {
    // The same snapshot `refreshPauses` read at the top of the tick — see `tickBeads`. A
    // tracker mid-write is a passing state and the roster is a display, so keeping the
    // last one is better than blanking every section on the card for one tick.
    const beads = await tickBeads(a);
    if (!beads) return a.epicAdvocates || [];
    const live = new Map(plannersOf(a).map((w) => [w.id, w]));
    const budget = a.epicLimit ?? DEFAULTS.maxEpicAdvocates;
    const overBudget = live.size >= budget;
    return assignedAdvocates(beads).map((epic) => {
      const w = live.get(epic.id) || null;
      const paused = isPaused(epic);
      return {
        id: epic.id,
        title: epic.title || epic.id,
        type: epic.issue_type || 'epic',
        labels: epic.labels || [],
        // Drawn as a state of the advocate rather than as a missing one. A paused epic
        // keeps its card, its window row and its button — that is what makes it
        // resumable, and a roster that dropped it would leave the only control that
        // brings it back on a card that is no longer there.
        paused,
        // Somebody has actually put an advocate on this epic — the label or the
        // waiting-on sentence, off `isEnrolled`. False for an epic that merely qualifies
        // (`wantsAdvocate`, the roster's own filter) and has never had one.
        assigned: isEnrolled(epic),
        window: w
          ? {
              at: w.at,
              pid: w.pid || null,
              claimed: Boolean(w.claimed),
              ended: Boolean(w.ended),
              // What the plan is over. A planner is shown every ready child rather than a
              // capped batch (`maxBatchBeads` bounds a brief that says "do all of these",
              // not one that says "group these"), so this is the real size of the
              // judgement being made.
              beads: Array.isArray(w.batch) ? w.batch.length : 0,
              reachable: Boolean(w.term),
              asked: w.asked || null,
              checkedInAt: w.checkedInAt || null,
            }
          : null,
        why: w
          ? null
          : // Before the budget and before the queue, because it is the only one of the
            // three that is somebody's decision rather than a state of the machine: an
            // epic that is out of slots *and* paused is paused, and saying "waiting for a
            // slot" over it would send you to step `maxEpicAdvocates` for a window that
            // would not open if you did.
            paused
            ? 'paused — nothing will be dispatched under it until it is resumed'
            : overBudget
              ? `waiting for a slot — ${live.size} of ${budget} EpicAdvocates are open`
              : 'nothing under it is ready to plan yet',
      };
    });
  }

  // Coding windows only. An EpicAdvocate must not consume the global session budget, so
  // it must not be counted into the number that budget is measured against — this is the
  // half of "the worker limit does not affect the number of EpicAdvocates" that would
  // otherwise leak back in through `globalFree`.
  const totalWorkers = () => [...advocates.values()].reduce((n, a) => n + codersOf(a).length, 0);

  /**
   * And the windows this file did not open, which come out of the same budget.
   *
   * A resolver (lib/resolvers.js) is opened by the pull-request sweep rather than by an
   * advocate, and until bc-29b3 the two caps could not see each other: `globalMaxWorkers`
   * counted workers, `maxResolvers` counted resolvers, and a busy morning was legitimately
   * the sum of them with nothing anywhere asserting what that sum was. The Mac does not
   * care which subsystem opened a window — it cares how many are running its gate at once
   * — so the number that binds has to be one number, and this is the half of it that
   * subtracts here. The other half is the hook that makes a resolver yield to a full Mac.
   *
   * Never throws: a registry that cannot be read is not a reason to stop launching work,
   * and treating it as zero is the same answer the file gives a process that has never
   * had a resolver in it.
   */
  const totalResolvers = () => {
    try {
      return liveResolvers().length;
    } catch {
      return 0;
    }
  };

  /**
   * And one window kept back for the pull requests already in line for one — bc-xl7n.129.
   *
   * `totalResolvers` above made the two populations share a budget, which was half of it.
   * The other half is that a *queue* for that budget has to press on it, and until this it
   * did not: `noRoom` in lib/resolvers.js applies the Mac's whole cap, so a full Mac queues
   * every resolver, review and review-answer window the merge queue asks for — and nothing
   * on this side ever read that queue. A slot freed by a worker closing was handed straight
   * back to a new bead, and the drain that would have taken it runs on a twenty-second
   * timer and lost the race. Measured on 2026-08-23: the line grew 8 → 25 over three hours
   * and fell exactly once, when a window happened to close in a tick the dispatcher had
   * nothing ready for. The pipeline that *finishes* work was being starved by the one that
   * *starts* it, which is the wrong way round — a merged branch frees a worktree, a bead
   * and a slot, and a started one costs all three.
   *
   * **One, not all of them.** Reserving the whole line would empty the Mac of workers for
   * as long as anything waited, and the queue cannot use more than one slot at a time
   * anyway: the drain opens entries one after another, and each opened window is counted by
   * `totalResolvers` on the next tick, so the reservation renews itself for as long as it
   * is still owed. One is what makes the freed slot the queue's; it is not a share-out.
   *
   * **And nothing at all when the queue could not use it.** `noRoom` asks the resolvers'
   * own cap *first*, so a line held by `maxResolvers` rather than by this Mac is not
   * waiting for a window a worker could give up — reserving there would hold a slot open
   * against a queue that cannot take it, for ever, which is the same bug pointed the other
   * way. That bound is what keeps this from deadlocking the dispatcher.
   *
   * **It is subtracted here and nowhere else, and `globals()` in particular must not learn
   * about it.** That object is what the daemon hands lib/resolvers.js through
   * `accountAgainst`, so a reservation folded into its `live` would tell the queue the Mac
   * is fuller than it is and make it refuse the very window this is holding open — the
   * reservation would cancel itself, silently, and the card would still say the slot was
   * kept. This is a subtraction from what *this* file may spend, and nothing more.
   *
   * Never throws, for `totalResolvers`'s reason: a registry that cannot be read is not a
   * reason to stop launching work. `inLineForWindow` is split out because the card reads it
   * too — an unguarded second call two lines below a guarded one is the shape a reader has
   * to check rather than trust.
   */
  const inLineForWindow = () => {
    try {
      return queuedResolvers().length;
    } catch {
      return 0;
    }
  };

  const reservedForResolvers = () => {
    if (!inLineForWindow()) return 0;
    try {
      return liveResolvers().length < maxResolvers() ? 1 : 0;
    } catch {
      return 0;
    }
  };

  /**
   * And the windows neither of the two above knows it opened (bc-2uj4.13).
   *
   * `totalWorkers` and `totalResolvers` are both this daemon's own bookkeeping — a row
   * in `a.workers`, an entry in lib/resolvers.js's registry — and a window that exists
   * on the Mac without either is invisible to both. That is not hypothetical: bc-7qo.19
   * found a killed window whose shell outlived its `claude` process and re-ran the exact
   * command, so the Mac had five real windows open while this file's own count sat at
   * two and the card read `92 ready · at its limit of 2 session(s)` over a laptop that
   * was actually five deep. bc-7qo.19 stops a *new* duplicate from opening; it does
   * nothing about a window this daemon already does not know about, which is the gap
   * this closes.
   *
   * One more `ps` read, in the same shape `resight` and `withoutLiveSessions` already
   * take: `isWorkerLine` (lib/claude.js) is true for any *coding* window's own brief,
   * with no id needed to look for — a planner, a resolver and an Epic Advocate each open
   * with different fixed text and can never match it, so this can never double-count
   * what `totalResolvers` already has. A worker-shaped line that also matches a bead
   * this daemon holds a coder record for — `namesBead`, the exact check `linesNameBead`
   * uses — is one this file already knows about, however many times a bug re-ran it;
   * only a line naming nothing on record counts here. Gated by `holdLiveSessions`,
   * because it is the same feature by the same evidence, and off is off for both.
   */
  const unattendedWorkers = async () => {
    if (o.holdLiveSessions === false) return 0;
    let lines;
    try {
      lines = await psLines();
    } catch {
      return 0;
    }
    if (!lines.length) return 0;
    const known = [];
    for (const a of advocates.values()) {
      for (const w of codersOf(a)) known.push(`${a.name}/${w.id}`);
    }
    let n = 0;
    for (const line of lines) {
      if (!isWorkerLine(line.args)) continue;
      if (known.some((pair) => namesBead(line.args, pair))) continue;
      n++;
    }
    return n;
  };

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
    // a bead with nothing decided above it is not work, so it must be gone before a plan can name
    // it, a batch can fold it in, or the card can count it. See `withoutOrphans`.
    //
    // `withoutOwed` sits right beside it and for a related reason — a bead whose own close
    // is mid-retry is not work either, and letting a plan or a batch fold it in would be
    // building on a bead about to disappear out from under it. See `withoutOwed`.
    const queue = withoutOwed(a, await withoutOrphans(a, ranked));

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
    const undecided = [];
    // What was already being said about an undecided epic on the last tick, so a hold that
    // lasts a day costs one line rather than two thousand eight hundred — `withoutTwins`'s
    // idiom, self-pruning because it is rebuilt from the previous list every pass. This one
    // is loud where `heldByChildren` is silent, and lib/container.js's rule is why: a hold
    // that clears itself when a window closes must not teach anyone to scroll past it, and
    // this one clears only when somebody decides something.
    const saidUndecided = new Set((a.heldByUndecided || []).map((h) => h.id));
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
      // Two lists out of one answer — bc-jvt0.4. `undecided` is a bead nobody has judged
      // and every other hold here is a bead something else is doing instead; counting the
      // first as the second would put "waiting on their children" on the card over an epic
      // that has none. See `heldByChildren`.
      const hold = await heldByChildren(a, bead, queue);
      if (hold?.undecided) {
        undecided.push({ id: bead.id, why: hold.why });
        if (!saidUndecided.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${hold.why}`);
      } else if (hold) held.push({ id: bead.id, why: hold.why });
      else workable.push(bead);
    }
    a.heldByChildren = held;
    a.heldByUndecided = undecided;
    // One read, two filters. `withoutTwins` has always paid for this list — it is the only
    // way to see a bead somebody claimed by hand — and `withoutLeases` wants the *labels*
    // off the same rows, which it was throwing away. Threaded rather than read twice
    // because the second copy would be a `bd list` per survey for a fact already in hand,
    // and a survey runs twice in a tick when `landed` moved something. See `inflightOnce`.
    const inflight = inflightOnce(a);
    // `withoutClaimedFiles` sits last of the six that read one bead at a time, on purpose:
    // its evidence is a *file* rather than the bead, so a bead any of the other five would
    // also hold reads better as "a window is already open on it" than as "somebody is
    // editing lib/advocate.js". It is also what makes the self-collision impossible — a
    // bead whose own session holds those files was taken out by `withoutLiveSessions` one
    // call in. `kin` travels because the surface is read from the bead's whole row, and the
    // queue row is deliberately narrow. See lib/beadfiles.js.
    //
    // And `withoutCollidingSiblings` is outside even that one, because it is the only
    // filter here whose input is the *result* of the others: bc-42ow.4 compares the beads
    // this tick is about to open against each other, so it cannot run until they are known.
    // Everything inside it subtracts a bead for a reason that exists whether or not the
    // rest of the queue does; this one is a fact about the queue itself.
    return withoutCollidingSiblings(
      a,
      withoutClaimedFiles(
        a,
        await withoutLiveSessions(
          a,
          withoutOpenPrs(
            a,
            await withoutTwins(
              a,
              // Innermost of the seven, and first for a reason the others do not have: a
              // pause is a decision and the rest are contention. A bead under a paused epic
              // reported as "another Mac has claimed it" or "a twin is already being worked"
              // would be true and would be the wrong sentence — you would go and look at the
              // other machine, when what is holding it is a button on this screen.
              await withoutLeases(a, withoutPausedEpics(a, workable), labels, kin, inflight),
              inflight
            )
          )
        ),
        kin
      ),
      kin
    );
  }

  /**
   * This survey's in-progress rows, read at most once and shared by the two filters that
   * want them.
   *
   * `withoutTwins` has read this list since bc-9frx's sibling — a bead somebody claimed by
   * hand is under way and out of `bd ready`, so the titles are the only way to see it — and
   * it uses the `title` off each row and drops everything else. `withoutLeases` wants the
   * `labels` off exactly the same rows, for bc-9otk: another Mac's claim on a *descendant*
   * of a queued bead. So this is the bc-zgfo shape a second time — the read was already
   * being paid for and thrown away, and the new rule costs nothing but the plumbing.
   *
   * A thunk rather than the rows, because the two filters run in the other order from the
   * one that reads: `withoutLeases` is innermost and returns before the read on a
   * single-person install (`leasing()` is false), where `withoutTwins` asks whatever the
   * config says. Lazy means "whoever needs it first", which is one call either way.
   *
   * Per survey and not per tick: the survey is the unit over which a queue is one queue,
   * and a tick that re-surveys after `landed` moved something wants the newer answer. A
   * failed read is `null` — distinct from `[]`, which is "nothing is in progress" — because
   * every caller here has the same rule and it is not the same answer: a tracker mid-write
   * must not be able to empty an advocate's queue, so cannot-tell holds nothing back.
   */
  function inflightOnce(a) {
    let job = null;
    return () => {
      if (!job) {
        // Through a resolved promise so that a `bd` without the method at all — which is
        // every hand-rolled fake in test/ that never needed it — is the same "cannot tell"
        // as a Dolt lock, rather than a synchronous throw out of the middle of a survey.
        job = Promise.resolve()
          .then(() => bd.listStatus(a.workspace, 'in_progress'))
          .then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => null);
      }
      return job;
    };
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
   * **Three ways the claim can be somewhere else, and only the first is on the bead.** A
   * claim on the bead itself is the straightforward one. A claim on a bead *above* it is
   * the same fact one level up: the other machine's window is responsible for a subtree,
   * and this bead is inside it. That is the hole a batch head opens — one window, several
   * beads, and only the epic leased. `heldByChildren` closes it for this laptop off
   * `a.workers`; `leaseHolderAbove` closes it for every other laptop off a label, which says
   * a machine and a moment and nothing about what that window took on.
   *
   * And a claim on a bead *below* it, which is bc-9otk and the same duplicate seen from the
   * other end: another Mac has a window inside this bead's subtree, so a window opened here
   * on the parent would be the second one in it. `heldByChildren` closes that for this
   * laptop too — its second check is any live worker under the bead — and `leaseHolderBelow`
   * is that check asked of the shared tracker. It matters most for a **plain parent**: an
   * epic with an open child is already held by `heldByChildren`'s third check whatever
   * status that child is in, but a task with subtasks is not an epic, so nothing looked.
   *
   * @see leaseHolderBelow for why that half is a filter and never a stand-down.
   *
   * Only somebody else's claim holds. This machine's own lease on a ready bead is a
   * *released* one — the worker ended, or the delivery reopened it — and holding a bead
   * behind our own claim would be an advocate refusing its own work forever. Expiry is
   * lib/lease.js's, and it is what stops a Mac that went to sleep parking a bead: a claim
   * older than `leaseMinutes` is not a holder, and the bead comes back on its own — which
   * is also the bound on how long an ancestor's claim can park a subtree.
   */
  async function withoutLeases(a, queue, labels, kin = null, inflight = null) {
    const alreadySaid = new Set((a.heldByLease || []).map((h) => h.id));
    a.heldByLease = [];
    if (!leasing() || !queue.length) return queue;

    const now = new Date();
    // This tick's parent edges, for the downward half. Read once for the whole survey off
    // the export the tick already pays for, and `null` where the tracker would not answer —
    // which is the id fallback, not an empty answer. See `tickParents`.
    const parents = await tickParents(a);
    // One per survey, shared by every bead in it: siblings have the same ancestors, so an
    // epic with five ready children is one read rather than five.
    const above = new Map();
    // And the downward half, which is one list for the whole queue rather than a cache that
    // fills: there is no id to enumerate, so the question is turned round and asked of every
    // claim at once. Computed on first use so that a queue nothing holds never touches it.
    let below = null;
    const leasedElsewhere = async () => {
      if (!below) below = await claimsElsewhere(now, inflight);
      return below;
    };
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
        // And the same question the other way down, asked last because it is the widest: a
        // bead its own claim or its ancestor's already accounted for reads better as the
        // nearer sentence. See `leaseHolderBelow`.
        const down = leaseHolderBelow(bead.id, await leasedElsewhere(), parents);
        if (down) {
          holder = down.holder;
          why = `${describeLease(holder, { now })} on ${down.descendant}, which is under it`;
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
   * Every bead another Mac has a live claim on, as `{id, holder}` — the whole downward
   * answer in one list, because the question cannot be asked the way the upward one is.
   *
   * `ancestorsOf` produces the ids to go and read; there is no `descendantsOf`, and the
   * only honest ways to get one are a `bd children` per queued parent per tick, recursively,
   * or the whole graph out of `bd export`. Both are a read per tick to learn something that
   * changes about as often as a Mac opens a window. So the question is turned round: rather
   * than "what is under this bead, and is any of it claimed", it is "what is claimed, and is
   * any of it under this bead" — and `underEpic` answers the second for free, at any depth,
   * against this tick's export, which is already in hand.
   *
   * **In-progress rows, and the gap that leaves is covered by the filter above it.** A bead
   * another Mac's advocate has staked is claimed by its worker within the first minute, so
   * "leased" and "in progress" are the same set by the time a `bd dolt pull` could show
   * either — the two writes ride the same sync. In the window where they have not, the bead
   * still carries no claim *here*, which means it is still in this tick's `bd ready` — and
   * `heldByChildren`'s first check holds a parent whose child is ready, for the same reason
   * this holds one whose child is claimed. The two halves cover each other.
   *
   * **What it costs is nothing.** `withoutTwins` reads this list on every survey already and
   * uses the titles; this reads the labels off the same rows. `inflightOnce` is the thunk
   * they share, and on a single-person install the caller has returned on `leasing()` before
   * getting here, so the read is `withoutTwins`'s alone exactly as it was.
   *
   * Our own claim is not somebody else's, the same way round as everywhere else here: the
   * beads this Mac's own windows are on are `a.workers`, and `heldByChildren` has already
   * had its say about those.
   */
  async function claimsElsewhere(now, inflight) {
    const rows = inflight ? await inflight() : null;
    const out = [];
    // Null is "the tracker would not answer", and it holds nothing back — a `bd` mid-write
    // must not be able to empty this queue. Same rule as `leaseHolderAbove`'s cache miss.
    for (const r of rows || []) {
      if (!r?.id) continue;
      const v = leaseVerdict(r.labels || [], me, { now, ...leaseOpts() });
      if (v.lost) out.push({ id: r.id, holder: v.holder });
    }
    return out;
  }

  /**
   * Another Mac's live claim on a bead *below* this one, or null — `heldByChildren`'s
   * downward check, asked of the shared tracker rather than of `a.workers`.
   *
   * bc-9otk. Mac A opens a window on `x-1.1`, a subtask, and claims it. `x-1` — a plain
   * task, its parent — goes ready here. Nothing held it: its child is claimed and therefore
   * out of `bd ready`, so the first check found no ready child; the worker that would have
   * been found by the second is in an `a.workers` on the other machine; and the third asks
   * `bd children` only of an **epic**, which a task with subtasks is not. So a window opened
   * on `x-1` while `x-1.1` had one on the next desk — two windows in one subtree, which is
   * the whole of what lib/lease.js exists to prevent.
   *
   * Unqualified, like the local check it mirrors and for the reason bc-zgfo gives: the two
   * rules must not resolve one pair of beads one way when the window is on this Mac and
   * another way when it is on the next desk, and the desk is the only difference between
   * them. `heldByChildren`'s downward check has never had a qualifier — any live worker
   * under a bead holds it — so neither does this.
   *
   * **A filter and never a stand-down, which is the one place this and `leaseHolderAbove`
   * are deliberately not symmetric.** `reconcile` stands a window down when a claim is
   * *above* it, and that resolves the after-the-fact collision to exactly one survivor:
   * the machine above keeps its window, the machine inside withdraws. Asking the downward
   * question there too would make both of them withdraw — A stands down because B is above,
   * B stands down because A is below — and a subtree nobody is working is worse than the
   * duplicate. So this runs before a launch, where the answer is "do not open a second
   * window", and never after one, where the answer is already settled.
   */
  function leaseHolderBelow(id, claims, parents = null) {
    // Nearest first, so a claim on the child names the child rather than a grandchild — the
    // nearer window is the more useful one to go and look at, which is `ancestorsOf`'s
    // ordering argument in the other direction.
    //
    // **Steps up the graph where the graph has them**, because once the filter below admits
    // an adopted child the dots stop measuring anything: `x-9` parented into `x-1` is one
    // step under it and would sort ahead of `x-1.1` on any reading of its id. Where the walk
    // does not reach — no export this tick, or a bead the export has no row for — it falls
    // back to the dots exactly as the filter does, relative to `id` so the two agree about
    // what "one level down" means. Depth and not string length there: `x-1.10` is no further
    // down than `x-1.2`, and sorting by characters would say it was.
    const dots = (i) => String(i).split('.').length;
    const depth = (i) => {
      const steps = graphAncestors(parents, i).indexOf(String(id));
      return steps >= 0 ? steps + 1 : dots(i) - dots(id);
    };
    const under = claims
      .filter((c) => underEpic(c.id, id, parents))
      .sort((x, y) => depth(x.id) - depth(y.id) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return under.length ? { descendant: under[0].id, holder: under[0].holder } : null;
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
   * Beads under a paused epic, taken out of the queue and said out loud.
   *
   * **The whole of what a pause costs the queue**, and it is a different kind of hold
   * from the six around it. Those are contention — two windows wanting one bead, one
   * branch or one file — and they resolve on their own when the other thing finishes.
   * This one is somebody having pressed stop, and the only thing that resolves it is
   * somebody pressing it again. That is why the sentence names the epic: a held bead
   * whose reason you cannot act on is a bead that reads as broken.
   *
   * Read off the **id** with `ancestorsOf`, not by walking the graph: `bc-lco2.3.1` is
   * under `bc-lco2` because bd's hierarchy is written into the id, which is the same fact
   * `isDescendantOf` and lib/reap.js's `namesBead` already lean on. So this is a Set
   * lookup per ancestor of each ready bead — no tracker call, no graph walk, nothing that
   * can fail — for a filter that runs on every survey.
   *
   * **The bead itself counts, not only its descendants.** A leaf root is workable in its
   * own right, and pausing its advocate and then dispatching a window onto the root is the
   * one reading of "pause" that nobody could defend.
   *
   * Nothing here touches `a.workers`. A pause explicitly does not take a slot back or
   * end a session — the windows that are up were told what happened and are expected to
   * reach an ending of their own (`pauseMessage`, and `control`'s `epicPause` below).
   */
  function withoutPausedEpics(a, queue) {
    const alreadySaid = new Set((a.heldByPause || []).map((h) => h.id));
    a.heldByPause = [];
    const paused = a.pausedEpics;
    if (!paused?.size || !queue.length) return queue;

    const workable = [];
    for (const bead of queue) {
      // Nearest first, so the sentence names the epic actually holding it rather than
      // the root three levels up — the same ordering argument `ancestorsOf` makes.
      const above = paused.has(bead.id) ? bead.id : ancestorsOf(bead.id).find((id) => paused.has(id));
      if (!above) {
        workable.push(bead);
        continue;
      }
      const why =
        above === bead.id
          ? 'its own advocate is paused'
          : `${above} is paused, and it is under it`;
      a.heldByPause.push({ id: bead.id, why, epic: above });
      // Once per bead per spell of being held, like every filter around it: a pause that
      // lasts a weekend would otherwise be thousands of identical lines about a queue
      // nothing is wrong with.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
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
   *
   * **A third guard now, under the same two (bc-xl7n.114).** `hit` and `opening` both
   * still need the session to have renamed itself, or this daemon's own record of a
   * launch it made moments ago — neither covers a window that has been going for a while
   * and simply never renamed, which is ordinary for a session that reads code and runs a
   * slow suite first, and it is exactly when the window looks quietest. `linesNameBead`
   * reads the fact the brief itself puts on the process's own argv from the moment it
   * starts, needing no rename and no bookkeeping of this daemon's own — see `resight`,
   * which is where the one `ps` read this costs is actually taken, once per tick for
   * every filter here rather than once per bead.
   */
  async function withoutLiveSessions(a, queue) {
    const alreadySaid = new Set((a.heldByLive || []).map((h) => h.id));
    a.heldByLive = [];
    if (o.holdLiveSessions === false || !queue.length) return queue;

    const lines = await psLines();
    const workable = [];
    for (const bead of queue) {
      const hit = (a.liveSessions || []).find((s) => namesBead(s.name, bead.id));
      // An Epic Advocate this daemon launched in the last ten minutes and whose window has not
      // named itself yet. The same gap `resight` names and the card covers — a window
      // carries no bead id until its first turn has run — and until bc-goo.15 nothing but a
      // person could open one, so the gap was a second or two wide and only ever after a
      // tap. It is now a sweep, which is what makes this worth the four lines: the failure
      // is two windows in one worktree, which is bc-vq78 and the worst one here.
      const opening = hit ? null : openedRecently(`${a.name}/${bead.id}`);
      const onArgv = !hit && !opening && linesNameBead(lines, a.name, bead.id);
      if (!hit && !opening && !onArgv) {
        workable.push(bead);
        continue;
      }
      const why = hit
        ? sittingWhy(hit)
        : opening
          ? 'an Epic Advocate was opened on it a moment ago and its window has not named itself yet'
          : 'a live process already names this bead on its own command line, though its session has not renamed itself';
      a.heldByLive.push({ id: bead.id, why, pid: hit?.pid ?? null, sessionId: hit?.sessionId || null });
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
      // And onto the row itself, which is the object `launch` hands straight to
      // `openWorkSession` as the bead (see the note on `next` in `snapshot`). bc-b9vt: the
      // window opens anyway, so the one thing left to do about the collision is tell the
      // session it is walking into it — otherwise it finds out at its first Write, from
      // scripts/claim-guard.sh's refusal, which is the exact lateness the dispatch-time
      // read exists to end. It rides the bead rather than being passed as an argument for
      // the reason `batch` and `group` do: `workPromptFor` stays a pure function of its
      // arguments, so test/land.mjs can assert the section with no advocate and no tick.
      bead.filesBusy = entry;
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
   * Two beads about to be opened in the same tick that expect to touch the same file.
   *
   * bc-42ow.4, and the one collision every other filter here is structurally unable to
   * see. `withoutClaimedFiles` above asks whether some session is *already* holding a file
   * this bead's surface names — bead against live claim — and it is the right question one
   * step earlier than scripts/claim-guard.sh asks it. But two ready beads whose surfaces
   * intersect, neither of which has claimed anything because neither has been opened, both
   * pass it and are dispatched together. The claim register cannot see that collision
   * because it has not happened yet; it happens about ninety seconds later, in two windows,
   * and the first anyone hears of it is claim-guard.sh refusing an edit. That is the same
   * lateness the dispatch-time read exists to end, one tick further up — and a tick already
   * knows every bead it is about to open, so comparing their surfaces to each other costs
   * nothing and the answer is free.
   *
   * ## Declared only, and only ever deferred
   *
   * A **declared** surface is a forecast somebody wrote on the bead; a **guessed** one is
   * lib/beadfiles.js having read the description. Only the first may hold, which is bc-hrno
   * answered and the position this file takes everywhere else — holding a bead out of a
   * tick on pattern-matched prose would be the expensive direction twice over. There is
   * deliberately no `holdGuessedFiles` branch here: that flag gates whether a guess may hold
   * against a *claim somebody is really holding*, and extending it to a second guess on the
   * other side would be a hold with no evidence at either end.
   *
   * And **deferred, not blocked**. The loser comes up on the next tick with nothing to
   * release, no timer and nobody to ask — the winner will have claimed its files by then, at
   * which point `withoutClaimedFiles` is what holds it and says so in the sentence that
   * names a branch. So this filter's whole life is one tick, which is why it keeps no state
   * between them and why its own `alreadySaid` set is the only thing carried across.
   *
   * ## Later defers to earlier
   *
   * The queue arrives ordered — priority, then the survey's own ordering — and the winner is
   * simply whichever bead is in front. Inventing a tiebreak here would be a second ordering
   * disagreeing with the one every other filter and the card already use, over a question
   * that resolves itself in thirty seconds either way.
   *
   * A batch head or a planner is compared on its own row like anything else. A plan *group*
   * needs no help from this: `plannedInto` already holds every non-lead bead of a group, so
   * two beads of one group are one window before this filter ever sees them — and two
   * groups that named one file were refused at plan time by `validatePlan`, which is
   * bc-42ow.3 and the strict end of the same rule.
   */
  function withoutCollidingSiblings(a, queue, kin = null) {
    const alreadySaid = new Set((a.heldBySurface || []).map((h) => h.id));
    a.heldBySurface = [];
    if (o.holdCollidingSurfaces === false || queue.length < 2) return queue;

    const workable = [];
    // Only what has been accepted so far, so the bead named in the sentence is one that is
    // really being opened this tick — a deferred bead must not go on to defer a third.
    const taken = [];
    for (const bead of queue) {
      // The whole row for the same reason `withoutClaimedFiles` wants it: the surface is in
      // the description and the queue entry is deliberately narrow. Declared only, so no
      // checkout is needed and none is passed — `guessedFiles` is what wants a directory to
      // check paths against, and a guess may not withhold work here at all.
      const files = declaredFiles(kin?.get(bead.id) || bead);
      if (!files.length) {
        workable.push(bead);
        continue;
      }
      // Two beads in two checkouts naming `lib/x.js` name two different files — the same
      // qualifier `validatePlan` puts on the plan-time refusal. `bead.repo` is `placeFor`'s
      // answer, already resolved at the top of the survey; where either side names no repo
      // there is nothing to tell them apart and the comparison stands.
      const clash = taken.find(
        (t) => (!t.repo || !bead.repo || t.repo === bead.repo) && collides(files, t.files)
      );
      if (!clash) {
        taken.push({ id: bead.id, repo: bead.repo || null, files });
        workable.push(bead);
        continue;
      }
      const hits = overlap(files, clash.files);
      const why = describeOverlap(clash.id, hits);
      a.heldBySurface.push({
        id: bead.id,
        why,
        files: [...new Set(hits.map((h) => h.a))],
        other: clash.id,
      });
      // Once per bead per spell of being deferred, like the filters above it. A pair that
      // keeps meeting every tick until one of them lands would otherwise be a line a minute.
      if (!alreadySaid.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
    }
    return workable;
  }

  /**
   * The beads nothing has decided — not a root, and no root above them. bc-rfnr.7.
   *
   * The queue half of the gate; the refusal half is at the door in lib/session.js, and
   * neither is the other's backup — see lib/underroot.js for why endorsement's two layers
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
   * `hasRootAbove` is where that is decided — an empty index has no roots and answers true.
   */
  async function withoutOrphans(a, queue) {
    const heldBefore = new Set((a.heldByNoRoot || []).map((h) => h.id));
    a.heldByNoRoot = [];
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
      if (hasRootAbove(index, bead.id)) {
        workable.push(bead);
        continue;
      }
      const why = `${NO_ROOT_ABOVE} — adopt it under an epic at any priority and it is workable, with no other change`;
      a.heldByNoRoot.push({ id: bead.id, why });
      // Once per bead per spell of being held, like the six filters below it — an orphan
      // sits in `bd ready` indefinitely and would otherwise be a line every thirty
      // seconds for as long as the daemon runs. The bus event goes with it rather than on
      // its own: it is the same news, and one repeated every tick would wake every parked
      // poller on the strength of nothing having changed.
      if (!heldBefore.has(bead.id)) {
        console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
        emit(a, 'noRoot', { id: bead.id, why });
      }
    }
    return workable;
  }

  /**
   * The beads whose merge-bead already closed on a merge, whose own close is still a
   * ledger entry in `lib/owed.js` rather than a fact in the tracker.
   *
   * bc-4r10.20. `finish` in lib/mergequeue.js closes the merge-bead first and the work
   * bead second, in the same function — but not in the same write, and the second close
   * can still be refused (a blocker with nothing to do with this pull request) or throw
   * after `Bd.close` has already spent its one `--force` attempt. Neither is silent any
   * more: `oweClose` records it and `sweepOwed` retries it every poll, *ahead* of the
   * advocate tick that reads this list (bc-8fyu, and the ordering note above
   * `retryOwedCloses` in lib/server.js). What that ordering cannot cover is the one tick
   * in which the record is *written*: `runMergeQueue` runs after `retryOwedCloses` and
   * before this survey, so a close that fails on this very beat is a record this beat's
   * retry has not seen yet — and without this filter, `bd ready` already shows the bead
   * as unblocked, because its blocker (the merge-bead) is the thing that just closed.
   * bc-4r10.9 sat open four days on exactly this shape, before `sweepOwed` even existed
   * to retry it — see the bead for the log lines.
   *
   * Read fresh every survey rather than cached: the ledger is a small local file, and the
   * entire value of this filter is seeing a record the beat it appears, not the beat
   * after. `readOwed` already answers `{}` rather than throwing on anything short of a
   * working file, so — like every other filter here — an unreadable ledger holds nothing
   * back.
   */
  function withoutOwed(a, queue) {
    const heldBefore = new Set((a.heldByOwed || []).map((h) => h.id));
    a.heldByOwed = [];
    if (!queue.length) return queue;

    let owed;
    try {
      owed = readOwed();
    } catch {
      return queue;
    }

    const workable = [];
    for (const bead of queue) {
      const rec = owed[`${a.name}/${bead.id}`];
      if (!rec) {
        workable.push(bead);
        continue;
      }
      const why = `already merged and waiting for its close to retry — ${rec.reason || 'owed a close'}`;
      a.heldByOwed.push({ id: bead.id, why });
      // Once per bead per spell of being held, like the filter above it: the ordinary
      // life of a record here is one poll, so this line is rare in practice and worth
      // seeing when it is not.
      if (!heldBefore.has(bead.id)) console.log(`[advocate] ${a.name}: ${bead.id} — ${why}`);
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
   *
   * **And an Epic Advocate this tick opened, which is the case with no session record at all.**
   * `reenter` runs after the survey and before the launch, so an epic that was in the queue
   * when the survey ran can have a 🧭 window on its way up by the time the queue is acted
   * on — with nothing on disk to see for another minute. Since bc-goo.15 that happens
   * without anybody pressing anything, so this asks the launch record as well as the
   * process table. Same switch, because it is the same rule: one window per bead.
   *
   * **A fourth check, and it is the one that does not need the session to have named
   * itself at all (bc-xl7n.114).** `namesBead(s.name, …)` and `openedRecently` both cover
   * gaps of a minute or so around a launch this daemon just made; neither covers a window
   * that has been going for a while and simply has not renamed — reading code and running
   * a slow suite for the first several minutes is ordinary, and it is exactly when the
   * window is quietest. `linesNameBead` reads the same fact the brief itself carries on
   * every process's own argv from the moment it starts (`sessionCommand` in lib/session.js
   * puts "You are working bead **`<workspace>/<id>`**…" on the command line), so it needs
   * no rename and no bookkeeping of this daemon's own — it would even catch a hand-opened
   * window nobody here launched. One `ps` read for the whole queue, not one per bead.
   *
   * `linesNameBead` matches the *qualified* `<workspace>/<id>`, never a bare id — a live
   * Claude Code process's argv can carry its whole system prompt, and this repo's own
   * memory store is full of sentences that quote a bead id as an example rather than as a
   * claim on it. Measured on this Mac while writing this: a bare-id match false-positived
   * on this daemon's *own* running session, whose context happened to quote "x-1" in a
   * memory note about `namesBead` itself.
   */
  async function resight(a, ready) {
    if (o.holdLiveSessions === false) return false;
    a.liveSessions = liveSessions(cfg);
    const named = ready.some((b) => a.liveSessions.some((s) => namesBead(s.name, b.id)) || openedRecently(`${a.name}/${b.id}`));
    if (named) return true;
    const lines = await psLines();
    return ready.some((b) => linesNameBead(lines, a.name, b.id));
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
   *    and only when there is a queue for the answer to change — and since bc-9otk the
   *    same one answers `withoutLeases`'s downward question off the labels on these rows,
   *    so the call is one call and not two. See `inflightOnce`.
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
  async function withoutTwins(a, queue, inflight = null) {
    // What was held on the last tick, so a bead held for an hour costs one line in the
    // log rather than one hundred and twenty. The card is where the standing state
    // lives; the log is for the moment it changed.
    const alreadySaid = new Set((a.heldByTwin || []).map((h) => h.id));
    a.heldByTwin = [];
    if (!queue.length) return queue;

    const working = [];
    for (const w of a.workers) if (w.title) working.push({ id: w.id, title: w.title, status: 'working' });
    try {
      // Shared with `withoutLeases` when the survey handed one over — same rows, different
      // column: this wants the titles, that one wants the labels. See `inflightOnce`.
      const rows = (inflight ? await inflight() : await bd.listStatus(a.workspace, 'in_progress')) || [];
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

    // The parent edges this tick's export carries, so the hierarchy exclusion below sees an
    // adopted child as `heldByChildren` now does. Off the shared read; `null` falls back to
    // the id. See `tickParents`.
    const parents = await tickParents(a);
    const workable = [];
    for (const bead of queue) {
      // Against `workable` and not `queue`: a bead is never its own twin, and the
      // second copy of three must not be judged against the first *and* hold the third.
      const ahead = workable.map((b) => ({ id: b.id, title: b.title, status: 'queued' }));
      // Hierarchy is `heldByChildren`'s business, and the two rules must not disagree:
      // a subtask often restates its parent's title almost word for word, and holding
      // `bc-3zo9.1` because a session is on `bc-3zo9` would be the exact opposite of
      // what that filter decided — an epic is not the work, its children are. `underEpic`
      // and not the id, for that same "must not disagree": an adopted child excluded there
      // and compared here is a bead held as its parent's twin by the one filter that still
      // could not see it was the parent's child.
      const rows = [...working, ...ahead].filter(
        (r) => !underEpic(r.id, bead.id, parents) && !underEpic(bead.id, r.id, parents)
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
   * Why this bead is not its own work — `{ why, undecided }`, or null, meaning it is work
   * in its own right.
   *
   * **`undecided` is which list the sentence goes in and nothing more** (bc-jvt0.4). Every
   * hold below but the last is *hierarchy*: something under this bead, or above it, is the
   * work instead, and `heldByChildren` on the card is that list. The last one is a bead
   * nobody has judged yet, which is not the same claim and must not be counted as it —
   * "waiting on their children" over an epic that has none is the kind of line that
   * teaches a reader to stop reading the line. So the caller splits them, and the
   * *detection* stays here because this is the one place that has already paid for the
   * `bd children` call the answer needs.
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
   * 4. **It is an owned epic with no children at all, and nobody has decided what that
   *    means** — bc-jvt0.4, and the one hold here that is not about hierarchy.
   *
   * ## Check 4, which reverses what this function used to allow on purpose
   *
   * This paragraph used to say that a leaf epic is deliberately still workable — *"an epic
   * with nothing under it is an ordinary bead with an ambitious type"* — and that sentence
   * is right about what such an epic **is** and wrong about who gets to say so. Nothing had
   * read the bead when the queue dispatched it. The Epic Advocate's brief, meanwhile, told
   * the one agent that *had* read it to decompose the epic whatever it said. So two rules
   * answered one question and whichever arrived first won, which on every tick is this one:
   * a childless epic went out as ordinary work on the first tick it was seen.
   *
   * Adam's decision (2026-08-21) is that the advocate judges and the default is to do the
   * work — so the allowance was the right *answer* and the wrong *author*. Now it waits for
   * an author. The three answers and what each writes are in lib/plan.js under
   * `WHOLE_LABEL`; here only two facts matter, and both ride on the row this already has:
   *
   * - **`whole-job` on the epic** means the decision was made and it was "one job", so the
   *   epic is workable as itself — the pre-bc-jvt0.4 behaviour, now arrived at rather than
   *   assumed. `isWholeJob` reads the label off `bead.labels`, which the queue row carries
   *   for `repo:`; no read is added to the tick.
   * - **Children** mean the decision was "several pieces", and then check 3 above already
   *   holds the epic with no help from this one. Which is why nothing marks that answer:
   *   the children *are* the marker.
   *
   * **Owned, and that word is the difference between a hold and a freeze.** `wantsAdvocate`
   * (lib/epicadvocate.js) needs an `owner:` label, so an unowned epic has no advocate and
   * never will — holding one would hold it for ever with nothing that could clear it. An
   * owned one has the three doors lib/reenter.js names, and its card on the phone carries
   * the button. Measured on 2026-08-22: all six open childless epics in this workspace are
   * unowned, so this check holds nothing today and arms itself the day one is owned.
   *
   * **Every child, not every *open* child.** An epic whose last child closed has been
   * decomposed — somebody judged it, and the judgement is in the graph — so it is check 3's
   * business and lib/finishedepic.js's, not this one's. `children.length` and not
   * `open.length` is the whole of that distinction.
   *
   * A container epic never reaches any of this: `Bd.ready` filters the label out of the
   * queue before the survey sees it (lib/container.js), so a standing root is still not
   * dispatched and still not held — it is not work at all.
   *
   * A `bd` that will not answer means "cannot tell", and cannot-tell keeps the bead:
   * a tracker mid-write must not be able to empty an advocate's queue. Note that for check
   * 4 the direction reverses — cannot-tell means the childless case cannot be established,
   * so the epic falls through to workable, which is what it did before this check existed.
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
    // Hoisted out of the loop it used to sit in: two questions below are "is this under
    // that", both want the same answer, and the export is one read per tick whoever asks
    // for it first. `null` is a tracker that would not answer, which every `underEpic` here
    // reads as the id fallback. See `tickParents`.
    const parents = await tickParents(a);

    for (const epic of epics) {
      if (!(labels.get(epic.id) || []).some((l) => String(l).trim() === PLANNED_LABEL)) continue;
      // An epic *adopted* into a planned one is inside that plan's subtree as surely as a
      // dotted child is, and a second set of groups dispatched over it is the pair of
      // dispatchers this check exists to prevent.
      const outer = [...planned].find((p) => underEpic(epic.id, p, parents));
      if (outer) {
        epicHold.set(epic.id, `${outer}'s plan already speaks for this subtree`);
        continue;
      }
      const plan = await readPlan(bd, a.workspace, epic.id);
      if (!plan) continue;
      planned.add(epic.id);

      // `beads` is what makes `done` a status check rather than a queue check: a bead that
      // is `unendorsed` or blocked behind a dependency is missing from `queue` exactly as a
      // closed one is, and reading that absence as finished is what filed a promotion bead
      // over work nobody had started (bc-4bet.2). This is the same per-tick export
      // `refreshPauses` and `rosterFor` share, so it costs no tracker call of its own — and
      // a tracker that would not answer is `null`, which `dispatchable` reads as not-done.
      const { groupOf: groups, plannedInto: members, done, unclosed } = dispatchable(plan, {
        queue,
        workers: a.workers,
        beads: await tickBeads(a),
      });

      // Ready under this epic and in no group — and not something a group is already
      // speaking for, which `unplanned` cannot know about because it only reads the plan.
      // The parent edges go with it: without them an adopted child is not "under" anything
      // and the epic never learns it has work nobody grouped.
      const loose = unplanned(plan, queue, parents).filter((b) => !groups.has(b.id) && !members.has(b.id));
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
        // The same test `unplanned` just used, with the same edges: an adopted child that
        // triggered this rewrite would otherwise not be held by it, and would take an
        // ordinary window against the plan being rewritten — the one thing this hold exists
        // to prevent.
        for (const b of queue) if (underEpic(b.id, epic.id, parents)) awaiting.set(b.id, epic.id);
        continue;
      }

      for (const [lead, group] of groups) groupOf.set(lead, group);
      for (const [id, lead] of members) plannedInto.set(id, lead);

      if (done && !loose.length) {
        promotable.push({ epic: { ...epic, labels: labels.get(epic.id) || [] }, plan });
        epicHold.set(epic.id, 'every bead in its plan is closed — a promotion bead carries what is left');
        continue;
      }
      const live = groups.size + members.size;
      // The third case is the one bc-4bet.2 added and the one worth naming: nothing of this
      // plan is ready and nothing is running, and it is *still* not finished, because beads
      // it named have not closed. Saying which ones is the difference between a card that
      // explains an epic sitting still and one that looks like a stall — they are almost
      // always unendorsed, waiting for Adam, or blocked behind a dep in another group.
      epicHold.set(
        epic.id,
        live
          ? `its plan is being worked in groups`
          : unclosed.length
            ? `its plan is written; nothing under it is ready and ${unclosed.length} of its beads ` +
              `${unclosed.length === 1 ? 'has' : 'have'} not closed — ${unclosed.slice(0, 3).join(', ')}` +
              `${unclosed.length > 3 ? ` and ${unclosed.length - 3} more` : ''}`
            : `its plan is written; nothing under it is ready`
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
   *     bead id plus `underEpic` is the whole test, and it is the same one the suppression
   *     uses — two windows must never hold one subtree, batch or not.
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
    // And the same again for the parent edges — four subtree questions below, one export,
    // already paid for by this tick. `null` is a tracker that would not answer, and every
    // `underEpic` here falls back to the id rather than to "no". See `tickParents`.
    const parents = await tickParents(a);

    for (const epic of epics) {
      if (foldedInto.has(epic.id)) continue;
      // Somebody has already decided about this subtree, and it was not a heuristic. Both
      // directions, for the reason the worker check below is both directions: an inner epic
      // under a planned one would otherwise become a batch head *inside* a plan, which is
      // two dispatchers on one subtree — the exact thing the plan is meant to replace.
      if (planned.has(epic.id) || [...planned].some((p) => underEpic(epic.id, p, parents))) continue;
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
      //
      // **`underEpic` and not the id — bc-b2k.2, and this pair is the concrete risk that
      // bead was filed over.** An epic adopted into another with `bd update --parent` keeps
      // a flat id, so the prefix read both of these as "nothing overlaps" and the epic was
      // dispatched with a window already open inside its own subtree. It also has to stay in
      // step with `heldByChildren` to the letter, and that one now walks the edges.
      if (a.workers.some((w) => underEpic(w.id, epic.id, parents))) continue;
      if (a.workers.some((w) => underEpic(epic.id, w.id, parents))) continue;
      // The children, and `underEpic` for the reason the guards above use it — except that
      // here it is what the epic is *for*: an adopted child the id could not see was left
      // out of the brief and out of `foldedInto` with it, so it took its own window
      // alongside the batch that should have carried it. Same predicate as `unplanned`,
      // which is what stops a planner and this disagreeing about an epic's children.
      //
      // Same checkout only. Since bc-l853.4 a bead names its repo (`repo:` label →
      // `bead.repo`), and one window opens in exactly one of them — the epic's. A child
      // living in another repo briefed into this batch would be worked in the wrong tree,
      // so it is left out and takes its own window in its own checkout later; the ancestor
      // guard holds it while the batch runs, which costs it a wait and not a mistake. Both
      // null in a single-repo workspace, which is every workspace that has not opted in.
      const kids = queue.filter(
        (other) => underEpic(other.id, epic.id, parents) && !foldedInto.has(other.id) && (other.repo ?? null) === (epic.repo ?? null)
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

  /** The hierarchy answer — checks 1 to 3, which all mean "something else is the work". */
  const hierarchy = (why) => ({ why, undecided: false });

  async function heldByChildren(a, bead, queue) {
    // The edges, not the id — bc-b2k.2. All three checks below are "is this bead in that
    // subtree", and a child *adopted* in with `bd update --parent` keeps a flat id, so the
    // prefix answered no about beads the tracker itself calls children: an epic launched
    // over a ready child, or beside a window already working one. Off this tick's shared
    // export, so it costs the third check's `bd children` call nothing extra, and `null`
    // — a tracker that would not answer — is the id fallback rather than an empty hold.
    const parents = await tickParents(a);
    const child = queue.find((other) => underEpic(other.id, bead.id, parents));
    if (child) return hierarchy(`${child.id} is ready under it`);

    const worked = a.workers.find((w) => underEpic(w.id, bead.id, parents));
    if (worked) return hierarchy(`a session is working ${worked.id} under it`);

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
    // open children** — which check 4 below still lets through where nobody owns it, or
    // where its advocate has recorded that it is one job — and then gains one, which is
    // what an agent filing a bead under the epic it is working does. bc-2uj4 was itself in
    // the second state while this was written, and bc-jvt0.4 narrowed the *set* of epics
    // that can launch that way without removing the case.
    //
    // The floor is unchanged where it matters: with no workers there is nothing to find,
    // and a worker on a bead with no descendants in the queue matches nothing. What this
    // costs is one array scan per held bead per tick over a list capped at `maxWorkers`.
    const above = a.workers.find((w) => underEpic(bead.id, w.id, parents));
    if (above) return hierarchy(`a session is working ${above.id} above it`);

    if (bead.type !== 'epic') return null;
    let children;
    try {
      children = await bd.children(a.workspace, bead.id);
    } catch {
      return null;
    }
    const open = (children || []).filter((c) => c && c.status !== 'closed');
    if (open.length) {
      return hierarchy(`an epic with ${open.length} open child ${open.length === 1 ? 'issue' : 'issues'}`);
    }

    // Check 4 — see the header. Below the open-children test rather than above it, so an
    // epic that is genuinely mid-decomposition is reported as what it is; and last of the
    // four because it is the only one that is not contention, so anything that *is* should
    // be said first about a bead both could be true of.
    const owner = ownerOf(bead);
    if (!(children || []).length && owner && !isWholeJob(bead)) {
      return {
        undecided: true,
        why:
          `a childless epic ${owner} owns, and nothing has decided whether it is one job or several — ` +
          `its advocate does that, and records one job as \`${WHOLE_LABEL}\` or several as children under it`,
      };
    }
    return null;
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
    /**
     * The workers whose bead is still claimed by a window that is gone.
     *
     * Collected here and acted on after the loop, beside the unstake that already runs
     * there: deciding every worker's ending first and writing afterwards means a tracker
     * that hangs on one bead's hand-back cannot hold up the ending of the worker behind
     * it. See `handBack`.
     */
    const stranded = [];
    /**
     * Mark this worker's bead as one to hand back — if it is claimed, and if nobody is
     * sitting in it.
     *
     * Both halves matter. A bead nobody claimed needs nothing: `bd ready` already has it,
     * which is why `lapsed` never reaches here. And a window that is *still typing* is the
     * one thing that makes the claim true, whatever this advocate has decided about the
     * slot — `timeout` and `silent` are both endings a session can reach mid-sentence, and
     * un-claiming under one of those is how bc-vq78 got two windows on one bead.
     *
     * `idle` counts as gone, and that is not a shortcut: a worker's window holds exactly
     * one turn — the brief — so the moment that turn is over is the moment the session is
     * finished, which is the same argument `quiet` above is built on and the same one
     * lib/reap.js closes windows with. It is also the case that matters most here. A window
     * whose agent fell over does not vanish; the TUI sits there idle for two hours, and a
     * gate on the window's mere *existence* would hold the claim for exactly as long as
     * nobody happened to close it. Anything else — `busy`, or a status file this laptop
     * could not read — holds the bead, because neither is evidence that the work stopped.
     */
    const strand = (w, live) => {
      if (w.claimed && (!live || live.status === 'idle')) stranded.push(w);
    };
    // One tracker call for the whole pass, shared by every worker that needs it. It used
    // to be one per *ended* worker, which was at most a handful a day; now a worker whose
    // window is merely idle asks too, and that is a question about every quiet window on
    // every tick. `listLabel` returns the workspace's open delivery cards whoever asks,
    // so there was never anything per-worker about the call itself. See `deliveryFor`.
    const deliveries = {};
    /**
     * How long a launch is given to reach line 3 of its command, or `0` for *do not ask*.
     *
     * Read once per pass rather than per worker, like the two caches below it, and read
     * here rather than at launch on purpose: a daemon whose owner has just turned the
     * probe off should stop probing the windows it already has open, not only the next
     * ones. `0` and `false` both mean off, and `clampInt` would turn either into 5 — hence
     * the explicit test in front of it.
     */
    const startGrace =
      o.neverStartedSeconds === false || Number(o.neverStartedSeconds) === 0
        ? 0
        : clampInt(o.neverStartedSeconds, 5, 600, DEFAULTS.neverStartedSeconds);
    /**
     * And the same shape for the `gone` clock: once per pass, `0`/`false` off, so turning
     * it off stops the windows already open being judged by it rather than only the next
     * ones. See `goneMinutes` in `DEFAULTS` for what three minutes is buying.
     */
    const goneGrace =
      o.goneMinutes === false || Number(o.goneMinutes) === 0
        ? 0
        : clampInt(o.goneMinutes, 1, 240, DEFAULTS.goneMinutes);
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

      /**
       * Which live session *is* this worker — and, separately, who else is in a window
       * about its bead. Two questions, and answering them with one lookup is bc-2uj4.5.4.
       *
       * **Identity is the session id, and only the session id.** `launch` mints it before
       * the window exists and Claude Code reports it straight back off its own live-session
       * record, so it says "this is the same conversation" — which is what every line below
       * this actually means. The name was standing in for it, and a name is a string the
       * *session* writes about itself: `namesBead` cannot tell a worker's window from a
       * reviewer's, a resolver's or an Epic Advocate's window that merely quotes the same
       * bead in its title. Measured on this Mac: the worker row for `bc-zjab.12` had
       * re-bound onto `beadcause - review PR 617 (bc-zjab.12)` — the review window, opened
       * by a different part of this daemon on the pull request the worker had already
       * delivered. Three things follow from a re-bind and all three are live bugs. The
       * reviewer's window is a window an advocate holds a worker slot for, so `parkIdle`
       * steps over it and nothing ever closes it. The slot it occupies is one this
       * workspace cannot dispatch into. And when the bead does close, `closingFor` writes
       * the reviewer's pid *and its session id* onto the closing record, so guard 2 in
       * lib/reap.js — the guard whose whole job is "never signal a window that is not the
       * one we launched" — compares the reviewer against itself, agrees, and SIGTERMs a
       * review that is halfway through.
       *
       * **The name match survives as the adoption path and nothing else.** A worker with no
       * `sessionId` was adopted from a previous daemon, or launched before ids were minted;
       * for those the name is the only handle there has ever been, and once one is found it
       * is written down, so a row is only ever adopted once. `namesBead` rather than a
       * substring, for its own older reason: a bead's subtasks are `<id>.1`, `<id>.2`, so
       * every parent id is a prefix of its children's and `includes` would join a worker to
       * a window working a different bead. See lib/reap.js.
       *
       * **`anyone` is deliberately the wide question, and it must stay wide.** It feeds
       * `strand` and nothing else: the claim comes back off a bead only when *no* window on
       * this Mac is in it, and a window somebody opened by hand — after this daemon's own
       * was closed, on the same bead — is exactly the window that makes the claim true. Ask
       * that one by identity and the claim is handed back under a live session, which is
       * how bc-vq78 got two windows onto one bead.
       */
      const mine = w.sessionId
        ? sessions.find((s) => s.sessionId === w.sessionId)
        : sessions.find((s) => namesBead(s.name, w.id));
      // Never overwritten with null, and for a harder reason than merely keeping the row
      // tidy: once the process is gone this id is the only route back to what it did, and
      // it is what decides whether the window may be closed at all. See lib/parked.js.
      if (!w.sessionId && mine?.sessionId) w.sessionId = mine.sessionId;
      const anyone = mine || sessions.find((s) => namesBead(s.name, w.id));
      w.pid = mine?.pid || null;
      w.sessionStatus = mine?.status || null;
      /**
       * Since when has this window been missing — the clock the `gone` ending reads.
       *
       * A timestamp rather than a boolean, and set here rather than where the ending is
       * decided, because the fact being recorded is *continuous* absence. `mine` is a
       * lookup by session id in a list Claude Code rewrites as sessions move, and a list
       * that is being rewritten can be read a moment short: one tick with no row for a
       * window that is working perfectly well. Stamping the first tick that cannot see it
       * and clearing the stamp on any tick that can is what turns a run of observations
       * into the one thing worth acting on.
       *
       * **Three guards, all on this line.** `w.sessionId`, because a worker adopted from an
       * older daemon has no id and is matched by *name* — `mine` is null for it whenever
       * the session has renamed itself, which is most of the time, and a rule that read
       * absence off that would kill every adopted window on this Mac. `sessions.length`,
       * because an empty list is the reader having failed, not every agent on the Mac
       * having died at once — the `lapsed` ending below uses the same belt for the same
       * reason. And `w.goneSince ||`, so the stamp is the *first* sighting and never the
       * latest one; restamping every tick is a clock that never reaches its own grace.
       */
      w.goneSince = w.sessionId && !mine && sessions.length ? w.goneSince || iso() : null;
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
       * The window that opened and never ran a line, which is not an ending a session
       * reached — it is the absence of a session altogether.
       *
       * A dispatch types `source '<file>'` into a shell that is still running `~/.zshrc`,
       * and anything in there that reads the terminal reads those bytes instead: on
       * 2026-08-21 oh-my-zsh's upgrade prompt ate the `s` and the window submitted
       * `ource '<file>'` (bc-xl7n.113.1 is that half). What made it expensive was that
       * nothing noticed. The window is alive, at a zsh prompt, with the bead's name on
       * its tab; the bead sat in this worker list for `workerTimeoutMinutes`, was then
       * charged an attempt for a session that never existed, and two of those retire a
       * bead from `candidates` for good. 55 windows in eighteen hours, at the point it was
       * measured.
       *
       * So the evidence is the launch's own temp files, and `launchProgress` is where the
       * whole argument for reading them lives. Three things about *this* branch:
       *
       * **Ahead of every inference below it, and behind the two facts above it.** A closed
       * bead and a gone bead are facts the tracker just handed over, and they outrank
       * anything on a disk. Everything after this — delivered, handed back, stood down,
       * exited, silent, timed out, lapsed — is this daemon reading a quiet window and
       * guessing, and a window that never started looks like all seven of them. It is not
       * a guess, so it goes first, and it cannot collide with `delivered` or `handback`
       * however they are ordered: both consumed their prompt file at line 2, an hour
       * before they got anywhere near an ending.
       *
       * **No attempt.** Not `delete`, which would wipe a genuine earlier failure — simply
       * not charged. A launch that never ran is not an attempt at the work, and this is
       * the load-bearing half: the slot comes back either way on the timeout, but the
       * attempt counter is the thing nothing decrements.
       *
       * **`strand`, not an unconditional hand-back.** A window that never started never
       * claimed anything, so ordinarily there is nothing to put back and `strand` does
       * nothing at all. It is here for the case where the bead was *already* claimed when
       * this launch went out, and it carries `strand`'s own guard for free: a live busy
       * session naming this bead keeps the claim, because then the claim is somebody
       * else's and true.
       *
       * **And the sweep goes first, which is what makes being wrong safe.** The obvious
       * fear about a grace measured in seconds is the false positive: a Mac so loaded that
       * `~/.zshrc` takes longer than `neverStartedSeconds`, this branch cancelling a launch
       * that was about to work, and two windows ending up on one bead — which is bc-vq78
       * and the worst failure this file has. It cannot happen, and the reason is the order
       * of these three lines. `discardLaunchFiles` takes the command file away *before* the
       * slot goes back, and that file is the only thing the slow shell is ever going to
       * read: when it finally gets past its rc files it sources a path that is not there,
       * says so, and stays at its prompt. A launch cancelled this way is cancelled for
       * good, so the worst a mistimed grace costs is one wasted window and one fresh
       * dispatch — never a second agent on work somebody is already doing. Deleting after
       * `finish` would give up exactly that property.
       */
      if (startGrace && !ended && secsSince(w.at) > startGrace && launchProgress(w.launchFiles) === 'never-started') {
        const took = discardLaunchFiles(w.launchFiles);
        strand(w, anyone);
        finish(
          a,
          w,
          `its window opened and never ran the command — no attempt charged${took ? `, ${took} temp file(s) cleaned up` : ''}`,
          'never-started'
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
        // Which route it went by, carried on the worker so `parkWorker` can put the true
        // sentence on the parked row. A merge-bead is the queue's to merge and nothing is
        // waiting on Adam; a `pr-delivery` card is a tap he owes. `finish` takes a reason
        // and a kind and cannot take a third thing without every other caller passing it.
        if (delivered) w.delivery = delivered;
        finish(
          a,
          w,
          delivered
            ? `delivered as a pull request — waiting on ${delivered.id} for the merge`
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
        strand(w, anyone);
        finish(
          a,
          w,
          `the session exited without closing it${ended.code ? ` (exit ${ended.code})` : ''}`,
          'unfinished'
        );
        continue;
      }
      /**
       * The window is not there any more — bc-y7l2m.
       *
       * **This is a different fact from the three endings below it, and the whole feature
       * turns on the difference.** `silent`, `timeout` and `lapsed` are this daemon reading
       * a window that is *still on the screen* and inferring from its quiet that something
       * went wrong; the note beside `parkWorker` is right that a conversation which stopped
       * answering is not one to resume. A window that is **gone** stopped answering because
       * it was closed by hand, killed, or lost with its terminal — nothing about the agent
       * failed, and its transcript is sitting on disk intact. Throwing that away and paying
       * an hour to re-derive it, which is what the fresh brief on the next attempt costs,
       * is the wrong answer to the wrong question.
       *
       * Ordered here for the reason the never-started probe is ordered where it is: above
       * every ending that is an inference from silence, below every one that is a fact
       * somebody wrote down. A closed bead, a done marker, a delivery card and a `human`
       * label all outrank this — a window that delivered and was *then* closed reached its
       * own ending, and `delivered` is a better sentence than "it went away".
       *
       * **The first disappearance costs the bead nothing.** Same argument as `silent`, only
       * stronger: a window vanishing is evidence about the *window*, and a bead charged an
       * attempt for a terminal Adam closed would be given up on for something no session
       * did wrong. What bounds the loop instead is `resumes` — the conversation is carried
       * over once, and a resumed window that also disappears is no longer an accident being
       * repaired. That one is charged, is not parked, and the bead goes back to the fresh
       * brief the attempt counter was always arranging. See `maxResumes` in lib/parked.js.
       *
       * `strand` and not an unconditional hand-back, exactly as everywhere else here: if
       * somebody has a window of their own open on this bead — which is the likeliest thing
       * to be true right after ours went away — the claim is theirs and it stays.
       */
      if (goneGrace && w.goneSince && minsSince(w.goneSince) >= goneGrace) {
        const again = carryOver(w);
        if (!again) a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        strand(w, anyone);
        finish(
          a,
          w,
          `its window is gone after ${Math.round(minsSince(w.goneSince))}m — ` +
            (again
              ? 'no attempt charged, and the conversation comes back on the next dispatch'
              : `it has already been brought back ${Number(w.resumes) || 0} time(s), so this one is charged and the next window gets a fresh brief`),
          'gone'
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
          strand(w, anyone);
          finish(a, w, `asked to check in ${Math.round(minsSince(w.asked))}m ago and never answered`, 'silent');
          continue;
        }
      }
      if (minsSince(w.at) > clampInt(o.workerTimeoutMinutes, 5, 24 * 60, DEFAULTS.workerTimeoutMinutes)) {
        a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        strand(w, anyone);
        finish(a, w, `still open after ${Math.round(minsSince(w.at) / 60)}h — releasing the slot`, 'timeout');
        continue;
      }
      // A window that never claimed anything and left no process behind: gone.
      const graceOver = minsSince(w.at) > clampInt(o.lapseMinutes, 1, 240, DEFAULTS.lapseMinutes);
      // `anyone`, like `strand`: the question is whether a window about this bead exists
      // at all, not whether the one we launched does. `!sessions.length` already answers
      // it on this Mac and is kept as the outer belt; the narrower spelling would only
      // start to differ on the day that stopped being true.
      if (graceOver && !w.claimed && !anyone && !sessions.length) {
        a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
        finish(a, w, 'the session went away without claiming it', 'lapsed');
        continue;
      }
      // Direction (1) of bc-xl7n.114: the daemon renews bd's own per-issue claim lease
      // (`bd heartbeat`, not `held:`) for every worker it is still tracking here — which
      // is every worker that survived everything above without being finished. Nothing
      // in a worker's own brief ever calls `bd heartbeat`, so without this the lease on a
      // bead genuinely being worked runs out on its own clock regardless of whether the
      // work is still going. See `Bd.heartbeat` for why a failure there is swallowed
      // rather than thrown; the `typeof` guard is for a test double built against an
      // older shape of `Bd` rather than for anything the real client can lack.
      if (w.claimed && typeof bd.heartbeat === 'function') await bd.heartbeat(a.workspace, w.id);
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

    // And the claim itself, for the beads whose window went away still holding one. After
    // the unstake for the same reason the unstake is after the loop: both are writes, and
    // the reads are done.
    for (const w of stranded) await handBack(a, w);
  }

  /**
   * Put back the claim a window that is gone was still holding.
   *
   * A window claims its bead as its first act, because that is what stops a second window
   * being opened on top of it, and every ending the brief documents takes the claim off
   * again: a delivery closes the bead, `bin/plan.js` hands an epic back explicitly, "request
   * changes" reopens it (`bd.reopen`, lib/server.js). The endings *nobody* chose take it off
   * nowhere. So a window shut by hand, reaped on `workerTimeoutMinutes` or crashed leaves
   * `in_progress` on the bead for good — and a claimed bead is not in `bd ready`, so it is
   * out of every queue this daemon builds, permanently, on the strength of a session that
   * did nothing.
   *
   * `reconcile` frees the slot and charges the attempt, and `maxAttemptsPerBead` is the
   * proof that the bead was meant to come back: counting attempts on something that can
   * never be attempted again is counting nothing. This is the half that was missing.
   *
   * **An epic is where it bit first, and hardest** (bc-bp32). An epic worker claims its epic
   * like any other window, and `bin/plan.js` un-claims it as the last thing it does, because
   * the advocate reads plans off epics **in `bd ready`** — a claimed epic makes its own plan
   * invisible. A planner that died before that step left the epic claimed, the plan unread,
   * and the children falling back to one window each: degraded rather than stuck, and silent
   * about it. A batch head is the same shape. Fixed here rather than in anything
   * plan-specific, because the epic is only the loudest case of the general one.
   *
   * **What it does not touch.** `done`, `delivered` and `handback` are the session's own
   * account of having got somewhere, and all three want the bead left exactly as it is — a
   * delivered bead reopened would be handed to a new window while the pull request it is
   * waiting on sits there. `stood-down` is not this Mac's to release: the claim is one row
   * that both machines can see, and dropping it here would drop the winner's claim too.
   * `lapsed` never had one. And an observer changes nothing on this Mac, least of all a row
   * in somebody else's tracker.
   *
   * **`reopenAbandoned`, not `reopen`, and that distinction is the whole of bc-xl7n.85.**
   * bd 1.2.1 refuses to clear a claim from an actor that is not the holder, and on this
   * path the actor is beadcause and the holder is the human identity the window stamped on
   * itself — so the plain write is not refused *sometimes*, it is refused every time, and
   * the retries cannot help because nothing here is a race. Twenty beads had been refused
   * by the time anyone counted; four were still `in_progress` under no window at all. The
   * refusal names `--force` as the remedy for a claim that is abandoned, and this function
   * runs only when it is: it is called because the window is gone.
   *
   * A tracker that refuses the write *anyway* is still not an error worth stopping a tick
   * for: the bead stays claimed, which is where it already was, and the next window that
   * reaches one of these endings tries again. What changed is that this is now the rare
   * case rather than the only one.
   */
  async function handBack(a, w) {
    if (OBSERVING) return;
    try {
      await bd.reopenAbandoned(a.workspace, w.id);
    } catch (err) {
      console.error(`[advocate] ${a.name}: could not hand ${w.id} back to the queue — ${err.message.split('\n')[0]}`);
      return;
    }
    /**
     * And the fact `archiveFinished` needs a few lines later: this bead went back into the
     * queue, so anything the dead window built is about to become invisible (bc-xl7n.102).
     *
     * A flag on the worker rather than a second list, because `finish` has already pushed
     * **this same object** onto `a.finished` and the archive walks that — so the two halves
     * cannot drift apart, and a worker whose hand-back the tracker refused above never gets
     * the flag and never gets the comment. Set only after the write lands, for that reason:
     * a bead still claimed is not one anybody is about to reopen a window on.
     */
    w.handedBack = true;
    console.log(`[advocate] ${a.name}: ${w.id} — its window is gone and the claim was still on it; handed back to the queue`);
    emit(a, 'handed-back', {
      id: w.id,
      title: w.title,
      detail: 'the claim outlived the window — put back in the queue',
    });
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
   *
   * ## Two labels, because there are two things a delivery leaves behind
   *
   * `pr-delivery` was the whole answer while a worker's delivery *was* a card in the
   * inbox. Since bc-r941 it is not: a worker files a **merge-bead** — `merge-queue`, one
   * per pull request, a blocker on the work bead by construction — and stops, and a
   * `pr-delivery` card is raised only later, by lib/mergeadvocate.js, when the queue has
   * tried three times and the merge has become Adam's. So on any workspace whose workers
   * take that route, asking for `pr-delivery` alone asks whether the *merge failed*, and
   * a delivery that is going perfectly well answers no.
   *
   * What that cost is not subtle and is not about labels. `delivered` is the ending that
   * frees the slot and puts the window on the closing list; without it a worker that had
   * done everything right fell through every ending in `reconcile` to
   * `workerTimeoutMinutes`, so its slot was held for **two hours** against `maxWorkers`
   * and its window sat on the screen for the same two hours with
   * `** BEAD WORK DONE ** CAN BE CLOSED **` on it. Measured on this Mac: 204 `releasing
   * the slot` lines, and every `delivered as a pull request` line in the whole log belongs
   * to a workspace still on the old route. bc-zjab.12 filed its merge-bead at 15:07:20Z
   * and was still on the slot list, in its window, an hour later.
   *
   * Both queries in one pass, cached together, because they are one question asked of one
   * tracker and a worker that has stopped is asking it once either way. `openMergeBeadFor`
   * rather than a second `cardsForDelivery`: a merge-bead's spec lives in `notes` behind
   * its own markers, and reading it with the card parser is how two readers of one bead
   * start to disagree.
   */
  async function deliveryFor(a, beadId, cache = {}) {
    if (!('open' in cache)) {
      try {
        cache.open = await bd.listLabel(a.workspace, DELIVERY_LABEL);
      } catch {
        return null;
      }
    }
    // The card first, because it is the narrower claim: a `pr-delivery` card exists only
    // where the merge has already stopped being automatic, and where both exist that is
    // the more useful thing to name.
    const card = cardsForDelivery(cache.open || [], { bead: beadId })[0];
    if (card) return { id: card.id, queued: false };
    if (!('merges' in cache)) {
      try {
        cache.merges = await bd.listLabel(a.workspace, MERGE_LABEL);
      } catch {
        // Same reasoning as above, one label along: a tracker that will not answer is not
        // evidence that nothing was delivered. Left uncached so the next worker asks again.
        return null;
      }
    }
    const merge = openMergeBeadFor(cache.merges || [], { bead: beadId })[0];
    return merge ? { id: merge.id, queued: true } : null;
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
    // A worker leaves the slot list here, so this is the last moment anything knows what
    // it was. Two things follow from that and the order between them is the safety
    // property of the whole feature: **park first, close second.**
    parkWorker(a, w, kind);
    // If it reached one of its own endings — closed the bead, delivered, handed
    // it back — and is still running, the window is one of the ones that never closes.
    // Hand it to the reaper. See lib/reap.js.
    const closing = closingFor(w, kind, { enabled: o.closeFinishedSessions !== false });
    if (closing && !a.closing.some((c) => c.id === closing.id)) a.closing.push(closing);
    // `never-started` never reaches `closingFor` — no pid, so `REAPABLE` deliberately
    // leaves it out — but it is a window on screen the same as any other, and `term` is
    // what addresses it instead. Same off switch as the pid-based path: a Mac somebody
    // has turned this feature off on must stay turned off for both windows it closes.
    if (kind === 'never-started' && o.closeFinishedSessions !== false) {
      const closingWindow = closingNeverStartedFor(w);
      if (closingWindow && !a.closingWindows.some((c) => c.id === closingWindow.id)) a.closingWindows.push(closingWindow);
    }
  }

  /**
   * May this conversation be carried over one more time?
   *
   * Read at both ends of the same decision — `reconcile` asks it to know whether the
   * disappearance costs the bead an attempt, `parkWorker` asks it to know whether to write
   * the record at all — so it is one function rather than the same comparison twice. See
   * `maxResumes` in lib/parked.js for why the answer is normally "once".
   *
   * `w.resumes` is the trip count riding on the worker, put there by `launch` when it
   * resumed this conversation into this window. Absent on every worker that was briefed
   * fresh, which reads as zero, which is the truth about it.
   */
  function carryOver(w) {
    return (Number(w.resumes) || 0) < clampInt(o.maxResumes, 0, 10, PARK_DEFAULTS.maxResumes);
  }

  /**
   * The endings where a conversation with this agent still has somewhere to go, written
   * down so the next dispatch can bring the same agent back instead of briefing a stranger.
   *
   * **`handback`, `delivered` and `gone`, and deliberately not the other five.** The test
   * is not "did this window stop" — every ending stops a window — it is *does a
   * conversation with this agent still have somewhere to go*:
   *
   * - **handback** — it asked a question. The answer is the next turn, and the agent that
   *   asked is the only one that knows why it mattered. This is the ending the whole
   *   feature was asked for.
   * - **delivered** — a pull request is waiting on a tap. What comes back is a merge, a
   *   refusal or a review, and all three are things to say to the session that wrote the
   *   branch rather than to a stranger opened on the same bead.
   * - **gone** — nobody ended it; the window disappeared. This is the one added by
   *   bc-y7l2m, and it is the ending with *nothing* waiting on it: no answer, no tap, no
   *   decision. What it has instead is an agent an hour into a problem whose reasoning is
   *   still on disk, so where the two above resume to deliver news, this one resumes
   *   simply to carry on. `interruptedPrompt` in lib/resume.js is the difference, and
   *   `ending` on the record below is how the dispatch tells them apart.
   * - **done** — the bead is closed and the work is in. There is nothing to answer.
   * - **stood-down** — another Mac holds the bead. Resuming this conversation would be
   *   opening a second window on work somebody else is doing, which is what bc-2uj4 is
   *   for.
   * - **timeout, silent, lapsed** — the daemon inferring that a window went wrong. A
   *   conversation that stopped answering is not one to hand an answer to, and the next
   *   attempt deserves the fresh brief the attempt counter is already arranging. **Note
   *   what separates these from `gone` and it is not a matter of degree:** all three are
   *   read off a window that is *still there*, so the agent behind them may be wedged
   *   mid-turn and resuming it would resume the wedge. `gone` is read off a window that is
   *   demonstrably absent, which is the one case where silence says nothing at all about
   *   the agent.
   *
   * The sentence is the ending's own, not "it went quiet": `finish` is the one place that
   * knows *which* ending this was, and that is precisely what `parkIdle` cannot know about
   * the windows it sweeps.
   */
  function parkWorker(a, w, kind) {
    if (o.parkIdleWindows === false || OBSERVING) return;
    if (kind !== 'handback' && kind !== 'delivered' && kind !== 'gone') return;
    // The loop guard, and it is here as well as in `reconcile` because this is the write:
    // a conversation already carried over its limit must leave no record behind, or the
    // next dispatch finds one and brings it back anyway. Said out loud — a park that
    // silently did not happen is a resume that silently does not happen an hour later,
    // and from the console the two are indistinguishable from a fresh brief being correct.
    /**
     * A planner's window disappearing leaves nothing to bring back, for the reason `launch`
     * gives where it refuses to resume one: a planner is opened over an epic's **ready
     * children**, and which children those are is precisely what changes while it is away.
     * An agent resumed mid-plan would carry on planning a set of beads that is no longer
     * the set. `launch` would decline the record anyway — so parking it would only write a
     * row the console lists as a conversation waiting to come back, which nothing will ever
     * open, until it ages out a week later.
     */
    if (kind === 'gone' && w.planning) return;
    if (kind === 'gone' && !carryOver(w)) {
      console.log(
        `[advocate] ${a.name}: ${w.id} — not parking ${String(w.sessionId || '').slice(0, 8)}, ` +
          `its window has now disappeared ${(Number(w.resumes) || 0) + 1} times; the next one gets a fresh brief`
      );
      return;
    }
    if (!w.sessionId || !w.dir) return;
    /**
     * What the parked row says it is waiting for, and the third case is new.
     *
     * `delivered` used to mean one thing — a card in the inbox whose one tap is the merge
     * — so "waiting on you" was simply true of it. Since the merge queue it means two, and
     * the queue's own route is not waiting on Adam at all: the merge-bead is a blocker the
     * queue clears by merging, and the sentence that used to be right would send him
     * looking for a tap that is not there. `w.delivery` is what `reconcile` learned when it
     * decided the ending; a worker adopted from a daemon that predates it has none, and the
     * older sentence is the right answer for that, because that is the route it took.
     */
    const waitingOn =
      kind === 'gone'
        ? // Nothing is waiting on Adam here, and the sentence must not pretend otherwise:
          // this row appears on the same console list as the two below it, and a line that
          // reads like a question would send him looking for one that was never asked.
          'its window disappeared — the next dispatch brings this session back'
        : kind === 'handback'
          ? 'it asked you a question — answering the bead brings this session back'
          : w.delivery?.queued
            ? 'its pull request is on the merge queue — the merge brings this session back'
            : 'its pull request is waiting on you — the merge brings this session back';
    try {
      const state = loadAppState();
      saveAppState({
        // Out of the open register and into the park in one write, because a row in both
        // is a window the sweep will try to park again while a dispatch tries to resume
        // it. See the note on `opened` in lib/config.js.
        opened: dropOpen(state.opened, w.sessionId),
        // `a.name`, never `a.workspace` — see the note above `parkIdle`. Every `bd.*`
        // call in this file takes the workspace *object*, so reaching for `a.workspace`
        // here is the natural mistake, and it is the one that cost this feature its
        // first fortnight: the key came out `[object Object]/bc-x` and the record's
        // `workspace` came out the string `"[object Object]"`, which is truthy, passes
        // `parkable`, and matches no reader.
        parked: prunePark(
          recordPark(state.parked, beadKey(a.name, w.id), {
            sessionId: w.sessionId,
            dir: w.dir,
            workspace: a.name,
            bead: w.id,
            kind: w.planning ? 'planner' : 'worker',
            title: w.title || w.id,
            waitingOn,
            // Which ending this was, so `resumeFor` can hand the agent the right turn
            // rather than guessing at one from the sentence above. See `recordPark`.
            ending: kind,
            // And the trip count, carried on the worker since `launch` resumed it into
            // this window. Without it every second disappearance reads as the first and
            // `maxResumes` never binds — see the header of `recordPark`.
            resumes: Number(w.resumes) || 0,
          })
        ),
      });
      // What `archiveFinished` needs, and it is the mirror of `w.handedBack`: that flag
      // means "this bead is going back to a *fresh* window, so say what the dead one
      // built before the branch becomes invisible". A conversation parked for resume is
      // the case where none of that is true — the same agent comes back to the same
      // worktree — and the salvage comment would be telling it, about itself, that its
      // work was abandoned. Set only once the write has landed, for `handBack`'s reason:
      // a park that did not reach the disk will not be resumed, so the comment is right
      // again and must not be suppressed.
      if (kind === 'gone') w.parkedForResume = true;
    } catch (err) {
      // Not fatal, and not a reason to hold the window open either: the ending is real
      // whatever the state file did, and lib/reap.js closes an idle `handback` window
      // exactly as it did before any of this existed. What is lost is the resume.
      console.error(`[advocate] ${a.name}: ${w.id} ended ${kind} but could not be parked — ${err.message}`);
    }
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
      // Impatient, never careless: the busy check and the grace period are waived while
      // the maintenance window is forcing the Mac empty, and the two identity guards are
      // not. `decide` in lib/reap.js owns that distinction and argues it there.
      //
      // Read per call rather than latched when the window entered `closing`, so that a
      // window which ends — at the bound, or because the collection finished — takes the
      // impatience with it. A `force` left set would make every later close in the
      // daemon's life skip a guard written for the ordinary case.
      force: maintenanceForcing(),
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
   * Close the windows `finish`'s `never-started` branch queued — see `closingNeverStartedFor`
   * in lib/reap.js for why they cannot go through `reapClosing` above: there is no pid,
   * because no `claude` ever started, so there is nothing to signal and no Claude Code
   * session record to check one against. What there is instead is `term`, the iTerm
   * handle, and `closeNeverStarted` re-asks both of the bead's own hazards — the tab
   * still names the bead, no `claude` process is on its tty — against a fresh read taken
   * this instant, never the one `finish` had a tick or a restart ago.
   *
   * No escalation, unlike `reapClosing`: closing a window is one Apple event, not a
   * signal something can ignore, so there is no SIGTERM/SIGKILL pair to run through and
   * no `sentAt` to track. An entry is dropped the moment a verdict says why — `close`,
   * or one of the three reasons `decideNeverStarted` calls `drop` — and kept only when
   * `closeNeverStarted` itself could not be asked at all, so the next tick tries again
   * rather than leaving the window open forever on the strength of one bad round trip.
   */
  async function reapNeverStarted(a) {
    if (!a.closingWindows.length) return;
    if (OBSERVING) return;
    const kept = [];
    for (const entry of a.closingWindows) {
      let verdict;
      try {
        verdict = await closeNeverStarted(entry);
      } catch (err) {
        console.error(`[advocate] ${a.name}: could not check ${entry.id}'s never-started window — ${err.message}`);
        kept.push(entry);
        continue;
      }
      if (verdict.act === 'refused') {
        // `mayLaunch` said no — a suite, or BEADCAUSE_NO_LAUNCH. Kept rather than dropped:
        // the answer is about this *process*, not this window, and a daemon restarted
        // outside a suite is a daemon that can ask again.
        kept.push(entry);
        continue;
      }
      if (verdict.act === 'close') {
        console.log(`[advocate] ${a.name}: closed ${entry.id}'s never-started window — ${verdict.why}`);
        emit(a, 'closed', { id: entry.id, title: entry.title, detail: verdict.why });
        continue;
      }
      // 'drop' — the window is already gone, no longer names the bead, or a claude
      // process has since started in it. Only the last two are worth a line: a window
      // that is simply gone is the outcome closing it would have produced anyway.
      if (verdict.why !== 'the window is gone') console.log(`[advocate] ${a.name}: ${entry.id} — ${verdict.why}`);
    }
    a.closingWindows = kept;
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

  /* ------------------------------------------------------------------ parking */

  /**
   * Park the windows that have gone quiet — the third sweep, and the widest of the three.
   *
   * `reapClosing` closes a window this advocate holds a slot for. `sweepWindows` closes a
   * window that named a bead the tracker says is closed. Between them they cover a window
   * that *finished*, and neither of them can touch the one Adam actually has thirteen of:
   * a window that **stopped**. A resolver that pushed its rebase and has nothing left to
   * do, a MergeAdvocate waiting on a review, an Epic Advocate that wrote its waiting-on
   * sentence — every one of them has a bead that is still open and a name that says
   * nothing about being finished, so both sweeps look straight past them, correctly, and
   * they sit there until somebody reads them one at a time.
   *
   * **Why this is allowed to close them when those two are not.** Because of lib/parked.js
   * and nothing else. The reason the old sweeps are so narrow is that closing a window
   * destroys the only copy of what that agent worked out, so they only ever close windows
   * whose work is provably *elsewhere* — in a closed bead, in a merged pull request. This
   * sweep closes windows whose work is still in their heads, and it is only defensible
   * because the conversation is written down first and can be brought back by id. So the
   * order here is the safety property: **park, verify the park, then close.** A window is
   * never signalled on the strength of an intention to record it.
   *
   * **What it does not do.** It does not decide *what* a window was waiting for — it
   * cannot, and guessing would put a wrong sentence on the console. It records that the
   * window went quiet and leaves the sentence to whoever knows: `finish` writes one for a
   * worker's documented ending, and everything else gets "it went quiet", which is the
   * honest answer and is still infinitely more than a rectangle.
   *
   * Runs while paused, like the two sweeps above it and for the same reason — pausing
   * means "open no more sessions", not "leave the screen full" — and never while
   * observing.
   *
   * **Every lib/parked.js call below takes `a.name`, and none of them takes
   * `a.workspace`.** An advocate record carries both — the workspace *object* under
   * `workspace`, its name under `name` — and the two stores this file reads are keyed by
   * the name: `registerOpen` in lib/session.js writes `workspace.name` (every one of its
   * eight callers passes the string), and `answered` is written by the server under
   * `${ws.name}/${id}`. Every `bd.*` call in this file takes the object, so `a.workspace`
   * is the shape that reads correctly here and is wrong, which is exactly how it got in.
   *
   * It failed silently for a fortnight, and that is the part worth remembering: an
   * *object* compared against the *string* on every record is never equal, so
   * `openList(opened, a.workspace)` returned `[]` on every tick for every advocate and
   * the loop body below had never once executed. Nothing was parked, nothing left the
   * open register, and the console's parked list — `parkedList`, filtered the same way —
   * was permanently empty. There is no error state to notice: an empty list is what a
   * quiet laptop looks like. `beadKey`/`prKey` are worse still, because a template
   * literal *accepts* the object: the key came out `[object Object]/bc-x`, `parkable`
   * passed it, and `resumeFor` below found it again under the same wrong key while
   * `answeredBefore` missed the answer it was supposed to quote.
   */
  function parkIdle(a, sessions, { idleMinutes: override = null } = {}) {
    /**
     * `override` is Reclaim pressing the button, and it is the one caller allowed to say
     * *now*.
     *
     * The ten-minute grace exists because the sweep is *inferring* that a window has
     * stopped, from silence alone, and an inference deserves a longer look. A press is not
     * an inference — it is Adam saying "clear the ones that are quiet", about a screen he
     * is looking at. Waiting out a grace he did not ask for would make the button feel
     * broken, which is how the old one earned its reputation. `busy` still refuses,
     * because that guard is not about time at all.
     */
    const idleMinutes = override ?? clampInt(o.parkIdleMinutes, 1, 24 * 60, PARK_DEFAULTS.parkIdleMinutes);
    /**
     * How long the sweep yields to `reconcile` over a window on the slot list, and how long
     * a status that is neither `idle` nor `busy` is given before it is read as stale. Both
     * argued where their defaults live, in lib/parked.js.
     *
     * Floored at `idleMinutes` rather than clamped independently, because a worker grace
     * *below* the general one would be a setting that says "wait ten minutes before parking
     * anything, except the windows we know most about, which go sooner" — which is the
     * opposite of what the yield is for. `override` is Adam pressing Reclaim and does not
     * reach either of these; see the skip itself.
     */
    const workerGrace = Math.max(
      idleMinutes,
      clampInt(o.parkWorkerIdleMinutes, 1, 24 * 60, PARK_DEFAULTS.parkWorkerIdleMinutes)
    );
    const stuckMinutes = clampInt(o.parkStuckMinutes, 1, 7 * 24 * 60, PARK_DEFAULTS.parkStuckMinutes);
    let state;
    try {
      state = loadAppState();
    } catch {
      // An unreadable state file means the register cannot be read, which means nothing
      // can be parked safely. Leave every window open; that is the old behaviour.
      return;
    }
    let opened = state.opened || {};
    let parked = state.parked || {};
    let changed = false;
    /**
     * First, the records the bug above left behind — repaired before anything reads them.
     *
     * `parkWorker` really did park handed-back and delivered workers all fortnight; it
     * just wrote them under `[object Object]/<id>`, where no reader scoped to a workspace
     * can see them. Those are live conversations on live branches waiting for an answer,
     * and correcting the key without adopting them would lose every one of them silently.
     * `adoptStrays` is narrow enough to be safe — see its own note — and this is a no-op
     * on every tick after the first, and on every install that never ran the broken code.
     *
     * Above the `parkIdleWindows` switch on purpose, and for the same reason `parkedRows`
     * is: turning the sweep off means "close no windows", not "hide what is already
     * parked", and a repair that only ran with the sweep on would leave the console
     * denying the existence of conversations it is holding.
     */
    const adopted = adoptStrays(parked, a.name, (dir) => workspaceFor(cfg, dir));
    if (adopted !== parked) {
      const rescued = Object.keys(adopted).filter((k) => !(k in parked));
      parked = adopted;
      changed = true;
      console.log(
        `[advocate] ${a.name}: adopted ${rescued.length} parked conversation${rescued.length === 1 ? '' : 's'} ` +
          `written under the wrong key — ${rescued.join(', ')}`
      );
    }
    // Read on every tick and whether or not anything is parked *here*, because the card
    // has to be able to say "nothing is waiting on you" as confidently as it says the
    // opposite. Set before the switch below, so turning the sweep off stops windows being
    // closed and does not blank the list of what is already parked — those are two
    // different things and a switch that did both would look like data loss.
    a.parkedRows = parkedList(parked, a.name);
    if (o.parkIdleWindows === false || o.closeFinishedSessions === false || OBSERVING) {
      // An adoption still has to reach the disk, or the next tick does it all again and
      // the console's list is right only for as long as this process lives.
      if (changed) {
        try {
          saveAppState({ parked });
        } catch {
          /* the next sweep asks again */
        }
      }
      return;
    }

    for (const rec of openList(opened, a.name)) {
      // By id, not by pid and not by name — the whole reason the register is keyed this
      // way. See `parkDecision`.
      const live = sessions.find((s) => s.sessionId && s.sessionId === rec.sessionId);
      const { act, why, idleFor } = parkDecision(rec, live, { idleMinutes, stuckMinutes });
      if (act === 'wait') continue;
      if (act === 'drop') {
        opened = dropOpen(opened, rec.sessionId);
        changed = true;
        continue;
      }
      /**
       * A window this advocate holds a slot for goes through `reconcile` and `finish`,
       * which know what it was asked and can say which ending it reached. Parking it here
       * as well would race that, on the same pid, and would replace a sentence that means
       * something with "it went quiet".
       *
       * **So it yields to `reconcile` — for `workerGrace`, and then it stops yielding.**
       * That skip had no end, and `reconcile` has no clock shorter than
       * `workerTimeoutMinutes`: a worker whose ending it cannot classify — no delivery card
       * filed, no `human` label, bead still open — held its window for two hours, and
       * `timeout` is not in `REAPABLE`, so even that ending closed nothing. The window then
       * came back to this sweep anyway, two hours late, which is the whole of what the
       * unbounded skip bought. Measured: `bc-zjab.12` sat idle 58 minutes with
       * `** BEAD WORK DONE ** CAN BE CLOSED **` on screen. Twenty minutes is forty ticks
       * for `finish` to write a better sentence, and after that the honest one is better
       * than a rectangle.
       *
       * Nothing about the close gets looser: the park below still has to reach the disk
       * before anything is signalled, and `decide` in lib/reap.js still re-reads the status
       * and waits out its own grace. `reconcile` will reach its ending in its own time and
       * `parkWorker` will overwrite this record with the sentence it deserves.
       *
       * `override` — Reclaim, Adam pressing the button about a screen he is looking at —
       * skips this the way it skips the idle grace, and for the same reason.
       */
      if (a.workers.some((w) => w.sessionId === rec.sessionId || Number(w.pid) === Number(live.pid))) {
        if (override == null && Number(idleFor) < workerGrace) continue;
      }
      if (a.closing.some((c) => Number(c.pid) === Number(live.pid))) continue;

      const key = rec.bead
        ? beadKey(a.name, rec.bead)
        : rec.pr
          ? prKey(a.name, rec.pr)
          : sessionKey(rec.sessionId);
      const next = recordPark(parked, key, { ...rec, waitingOn: 'it went quiet — nothing has come back to it' });
      /**
       * The park has to be **on disk before the signal**, and this is the write that puts
       * it there.
       *
       * Written per park rather than batched at the end of the loop, which is the more
       * obvious shape and is wrong here: a batched write means the first nine windows are
       * signalled on the strength of a record that only reaches the disk after the tenth,
       * and a crash anywhere in between closes nine windows whose conversations nothing
       * can find. One `saveAppState` per park is a handful of writes a day, and it is what
       * makes the ordering true rather than merely intended.
       *
       * A failed write is a window left open. That is the correct direction and it is the
       * old behaviour: nothing is lost, the sweep asks again next tick.
       */
      try {
        // Pruned on the way in rather than only on the final write, so a store at its cap
        // cannot grow past it between sweeps. Safe against dropping what was just
        // written: `prunePark` keeps the newest and this record is stamped now.
        saveAppState({ opened: dropOpen(opened, rec.sessionId), parked: prunePark(next) });
      } catch (err) {
        console.error(`[advocate] ${a.name}: not parking ${rec.sessionId.slice(0, 8)} — ${err.message}`);
        continue;
      }
      parked = prunePark(next);
      opened = dropOpen(opened, rec.sessionId);
      // Everything pending has just gone to disk with it, so there is nothing left owing.
      changed = false;
      a.closing.push({
        id: rec.bead || (rec.pr ? `#${rec.pr}` : rec.title || rec.sessionId.slice(0, 8)),
        title: rec.title || rec.bead || rec.sessionId.slice(0, 8),
        pid: live.pid,
        // Which makes guard 2 in `decide` an identity check rather than a name check —
        // and for a window with no bead in its name, the only guard available at all.
        sessionId: rec.sessionId,
        at: iso(),
        sentAt: null,
      });
      console.log(`[advocate] ${a.name}: parked ${rec.kind} ${rec.bead || (rec.pr ? `#${rec.pr}` : rec.title)} — ${why}`);
      emit(a, 'parked', { id: rec.bead || rec.title, title: rec.title, detail: why });
    }

    if (changed) {
      try {
        saveAppState({ opened, parked: prunePark(parked) });
      } catch {
        /* the next sweep asks again */
      }
    }
    // And again, off what this sweep actually did, so a window parked on this tick shows
    // as parked on this tick rather than thirty seconds later. The list above was read
    // before the loop and is the right answer for every tick that parks nothing, which is
    // almost all of them.
    a.parkedRows = parkedList(parked, a.name);
  }

  /**
   * The parked conversation for a bead, made ready to resume — or null, with a reason.
   *
   * Everything about *whether* it can be resumed is lib/resume.js's; this is the lookup
   * and the sentence the resumed agent wakes up to. The answer text comes from `answered`
   * in the app's state, keyed by bead, which is exactly right for the ending the worker
   * brief actually teaches: ending 1 puts the question on the **work bead itself** (`bd
   * label add <id> human`), so the thing Adam answered and the thing being resumed are one
   * bead. A question filed as a separate bead with `beadcause-ask --blocks` has no answer
   * under this key, and then the turn says the question was answered without quoting it —
   * the agent reads the bead, which is where that conversation lives.
   */
  async function resumeFor(a, bead) {
    let state;
    try {
      state = loadAppState();
    } catch {
      return null;
    }
    const key = beadKey(a.name, bead.id);
    const rec = parkedAt(state.parked, key);
    if (!rec) return null;
    const ready = await prepareResume(cfg, rec);
    if (!ready.ok) {
      // Said out loud, always. A fresh session that reads as a resume is the one outcome
      // worth guarding against: it looks identical on the console, and the agent that
      // comes up has no idea it was supposed to know anything.
      console.log(`[advocate] ${a.name}: ${bead.id} — opening fresh rather than resuming, ${ready.why}`);
      try {
        saveAppState({ parked: dropPark(state.parked, key) });
      } catch {
        /* it will be pruned by age */
      }
      return null;
    }
    if (ready.restored) console.log(`[advocate] ${a.name}: brought ${ready.restored} back out of the attic to resume in`);
    /**
     * A conversation parked because its window disappeared wakes up to a different turn,
     * and the branch is on the recorded `ending` rather than on whether an answer happens
     * to be in hand — bc-y7l2m.
     *
     * Deciding it by the *absence* of an answer would be the natural shortcut and it is
     * wrong in the direction that matters. `answeredBefore` returns nothing for a perfectly
     * ordinary `handback` whose question was filed as its own bead with
     * `beadcause-ask --blocks` — the case the header above this function is about — and
     * that agent would then be told its window disappeared and nobody decided anything,
     * when in fact its question was answered and the answer is sitting on a bead it is now
     * being told not to go looking for. The ending is a fact the park wrote down; the
     * answer's absence is an inference about a store, and only one of those is safe here.
     */
    if (rec.ending === 'gone') {
      return {
        key,
        rec,
        prompt: interruptedPrompt({ owner: ownerName(cfg), bead: bead.id, parkedAt: rec.at }),
      };
    }
    const said = answeredBefore(state.answered, key);
    return {
      key,
      rec,
      prompt: resumePrompt({
        owner: ownerName(cfg),
        bead: bead.id,
        answer: said?.response || 'answered — the answer is on the bead.',
        parkedAt: rec.at,
      }),
    };
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
    // `model` and `tier` come back from a worker launch and not from a planner's: the
    // tier routes the window that does the work, and lib/session.js says why the one that
    // plans an epic is left alone. Undefined from that branch, which is the same as null
    // everywhere below and draws as nothing.
    /**
     * Is there a conversation parked on this bead? Then this launch is that conversation
     * continued, not a new one.
     *
     * Asked here, at the one seam every dispatch comes through, and nowhere else — see the
     * header of lib/resume.js for why the answer handler was the wrong place. Everything
     * above this line has already run: the endorsement door, the lease, the attempt count.
     * A resume is not a way past any of them; it is the same launch with the agent's own
     * memory still in it.
     *
     * A planner is never resumed. Its window is opened over an epic's *ready children*,
     * and which children those are is the one thing that has changed while it was parked —
     * so an agent resumed mid-plan would carry on planning a set of beads that is no
     * longer the set. A fresh brief is the correct answer there, and it is cheap: a
     * planner reads the graph rather than the files.
     */
    const back = planning ? null : await resumeFor(a, bead).catch(() => null);
    // `dept` and `relayProblem` come back from a worker launch and from no other door, for
    // the same reason `model` and `tier` do — and, for `dept`, for a sharper one on top:
    // the department is derived from the assignee, and this window's first act overwrites
    // it. `undefined` from the planner branch, which is `null` everywhere below; a planner
    // writes a plan rather than a deliverable and is not a member of any department.
    const { dir, mode, term, model, tier, sessionId, launchFiles, dept, relayProblem } = planning
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
          resume: back,
        });

    // The window is open, so the record has done its job and the park is over. Dropped
    // *after* the launch and never before it: a record cleared in advance of a launch
    // that then threw — iTerm refusing, macOS refusing the Apple event — is a
    // conversation nothing can find again, and the throw would look like an ordinary
    // failed dispatch. `countResume` first, because the trip count is a fact about the
    // conversation and outlives this particular record. See lib/parked.js.
    if (back) {
      try {
        const state = loadAppState();
        saveAppState({ parked: dropPark(countResume(state.parked, back.key), back.key) });
      } catch (err) {
        console.error(`[advocate] ${a.name}: resumed ${bead.id} but could not clear its park — ${err.message}`);
      }
      console.log(`[advocate] ${a.name}: resumed ${bead.id} in ${back.rec.sessionId.slice(0, 8)} rather than briefing a new session`);
      emit(a, 'resumed-session', { id: bead.id, title: bead.title, detail: `brought ${back.rec.sessionId.slice(0, 8)} back` });
    }

    a.workers.push({
      id: bead.id,
      // The other beads this window was briefed on, when it is a batch head. `id` stays
      // the epic — which is what keeps every single-id thing downstream correct without
      // knowing batches exist at all: the done marker, the check-in, the attempt count
      // and `reclaim` are all still keyed by one bead, and `underEpic(w.id, …)`
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
      // Which group of which epic's plan this window carries, or null — and, since
      // bc-2uj4.9, **which beads of it**. `dispatchable` hands the lead the group's other
      // ready beads and the brief names every one of them, so this window is working all
      // of them and `w.id` speaks for one; without the ids written down here the other
      // beads are in none of `busy`'s three arms and an hour later the re-entry sweep
      // reports a stall against a bead that is mid-delivery. Written at the launch because
      // that is where they are already in hand — re-deriving them in `busy` would mean
      // reading the epic's plan comment once per row per sweep.
      //
      // Deliberately not folded into `batch`, which is the same *question* and a
      // different *fact*: `heldByChildren` keys its upward guard on `w.batch.length` to
      // hold a whole subtree behind one window, and a group is a slice of a subtree rather
      // than the subtree — a lead that held its siblings' groups would stop the plan
      // dispatching the rest of itself. `workPromptFor` and the survey read the difference
      // too. See `workerHolds` in lib/reenter.js, which asks both.
      group: bead.group
        ? {
            epic: bead.group.epic,
            name: bead.group.name,
            beads: (bead.group.beads || []).map((k) => (typeof k === 'string' ? k : k?.id)).filter(Boolean),
          }
        : null,
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
      // What this window came up on, and what it was routed by (bc-nc6o.2). Both, and
      // not just the model, because "opus" alone cannot be read: it is the answer for a
      // bead somebody rated `high` and the answer for a bead nobody rated at all, and
      // those are the two things worth telling apart when the bill arrives. `tier` is
      // `''` for the unrated bead and `null` where its labels contradicted each other.
      //
      // Recorded here rather than derived by whoever draws it, for the reason the whole
      // of this record exists: the launch is over in a second and the window then runs
      // for an hour, so a card that recomputed the tier would be showing what the bead
      // says *now* rather than what this session was actually opened with. What the run
      // really used, once it has finished, is a separate fact and is bc-nc6o.3.
      model: model || null,
      tier: tier ?? null,
      /**
       * Which **department** this window is working in, or null — bc-ogicx.6, and the one
       * field on this record that could not be recomputed by anybody at any later moment.
       *
       * A relay is keyed off the bead's assignee, and the first thing the session in this
       * window does is `bd update --claim`, which overwrites the assignee with the claiming
       * identity. So a `capacity:` counted by re-deriving the department of every open
       * worker would count zero of them, always, and a ceiling that never binds is worse
       * than no ceiling at all — it reads on the card as a limit being honoured.
       *
       * Written from what the launch returned, which resolved the chain out of *this*
       * bead's checkout a second ago, and not from the queue row: a definition is a fact
       * about a directory that a branch may rewrite a minute from now, and the question this
       * field answers is what the window was opened under. Same argument as `tier` above.
       *
       * Null for a planner, for a bead with no relay, and for every window on every
       * workspace that has no definition — which is all of them today.
       *
       * **And null for a window this advocate did not open**, which is the one honest gap:
       * lib/server.js's red-base repair calls `openWorkSession` directly and takes only
       * `dir` off it, so that window is adopted here by `reconcile` with no department and
       * spends no department's ceiling. It is the same population `unattendedWorkers`
       * already accounts for separately, and it fails in the permissive direction — a
       * ceiling that under-counts opens a window too many, where one that over-counted
       * would stop a department dispatching on evidence nobody could go and look at.
       */
      dept: dept || null,
      /**
       * And the sentence, where a definition in this bead's checkout would not load
       * (bc-ogicx.6). **Never a hold**: this window is already open by the time the field
       * exists, and it was opened without a relay rather than not opened. `candidates` says
       * the same thing one step earlier and from the queue's side; this is the launch's own
       * account of what it read, kept because a re-read from the card would be showing what
       * the file says now rather than what this window got.
       */
      relayProblem: relayProblem || null,
      claimed: false,
      pid: null,
      sessionStatus: null,
      // The conversation this window is — known from the launch rather than discovered
      // from `~/.claude/sessions/<pid>.json` a tick later. `reconcile` still fills it in
      // for a worker adopted from before ids were minted, and never overwrites this with
      // null; see the note there. It is what makes the window closable: a window may only
      // be closed once its conversation is written down, and this is the id that gets
      // written. See lib/parked.js.
      sessionId: sessionId || null,
      /**
       * How many times this conversation has been carried over into a new window — the
       * trip count, riding on the worker between one park and the next.
       *
       * **It has to live here because the park record does not survive the launch.** The
       * record is dropped a few lines above, deliberately: a record left behind is a
       * conversation two dispatches would both try to resume. So the count's only home
       * between the drop and the next park is the worker, and `parkWorker` hands it back
       * to `recordPark` when this window ends. Miss this line and `maxResumes` never binds
       * — every disappearance reads as the first, and lib/parked.js's "the same window
       * reopens forever" is exactly what you get.
       *
       * Zero for a window briefed fresh, which is the truth about it: whatever happened to
       * whatever came before, *this* conversation has been round the loop no times.
       */
      resumes: back ? (Number(back.rec.resumes) || 0) + 1 : 0,
      // The iTerm session id, kept for the life of the worker: it is what `reclaim`
      // addresses to ask this window whether it is still working. Null on an iTerm
      // that would not report one, which reclaim treats as "cannot ask".
      term: term || null,
      // The three temp files that launch minted, which are what `reconcile` reads to find
      // out whether the shell in that window ever got as far as running any of this. Kept
      // on the record and therefore in advocates.json, because the process that knew them
      // is finished the moment `osascript` returns and the question is asked a minute
      // later. Null for a planner door that does not report them and for every worker
      // adopted from a daemon that predates the probe — `launchProgress` reads that as
      // `unknown` and leaves them to the timeout, exactly as before. See `launchProgress`.
      launchFiles: launchFiles || null,
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
    // The model goes in the launch line beside the permission mode, and for the same
    // reason it is there: it is a decision made silently at spawn and invisible
    // afterwards, so the log is the only place anybody can go back to and ask what a
    // session that has since closed was opened on. `unrated` rather than a blank, because
    // an absent tier is the commonest answer and a line that just stopped would read as
    // one that failed to print.
    const routed = model ? `, ${model}${planning ? '' : ` (${tier || 'unrated'})`}` : '';
    console.log(
      `[advocate] ${a.name}: ${what} in ${dir}${inRepo ? ` (${inRepo})` : ''} (${mode}${routed}, attempt ${attempt})`
    );
    emit(a, 'launched', {
      id: bead.id,
      title: bead.title,
      detail: planning
        ? `planning ${bead.id} in ${inRepo || path.basename(dir)}`
        : `session in ${inRepo || path.basename(dir)}`,
      repo: inRepo,
    });
    // And the same fact where a later session can reach it. Last in the launch, after the
    // window is open and the record written, for the reason the lease is *first*: a lease
    // has to beat the other Mac's next pull, and this has to describe something that
    // actually happened. A `bd` that will not answer must not be able to cost a window
    // that is already open, so `markDispatched` swallows its own failure.
    await markDispatched(a, bead.group);
  }

  /**
   * Say on the epic that one of its plan's groups took a window — bc-zjab.3.
   *
   * See `dispatchLabel` for what the mark is and why nothing reads it. Three things about
   * the write, all of them the same shape as `stake`: an observer instance changes nothing
   * on a shared graph, a bead that is not part of a plan has nothing to record, and a
   * failure is logged rather than thrown, because the window it would be failing is
   * already open and a record is not worth taking one back for.
   *
   * **From the launch and not from the survey**, which is the whole difference between
   * this and a mark `plansFor` could have written. A group the survey found dispatchable
   * and the worker cap then held back has not dispatched — it is first in line for the
   * next tick — and a label saying otherwise would be exactly the false reassurance the
   * bead is about, in the opposite direction.
   */
  async function markDispatched(a, group) {
    if (!group?.epic || !group?.name || OBSERVING) return;
    const label = dispatchLabel(group.name);
    try {
      await bd.addLabel(a.workspace, group.epic, label);
    } catch (err) {
      console.error(
        `[advocate] ${a.name}: opened "${group.name}" but could not mark ${group.epic} ${label} — ${err.message.split('\n')[0]}`
      );
    }
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
   * And the claim on a bead this Mac has a window open on that this advocate never opened.
   *
   * bc-3p53. `launch` stakes before it opens, so every window *this advocate* opens
   * carries a claim the other machines can read. Nothing else does. A bead opened from
   * the phone, a terminal seeded on one, a session somebody started in iTerm by hand —
   * on one laptop none of that has ever mattered, because `withoutLiveSessions` sees the
   * process and holds the bead on the strength of it. Across two Macs it is bc-bllw's
   * incident reached through a door bc-bllw did not close: the process is here, the other
   * machine has nothing to see, and its advocate opens a second window on a bead that
   * looks unclaimed to everyone but us.
   *
   * So the same evidence is *published*. `withoutLiveSessions` already decides "a window
   * is open on this bead" from a running process whose name carries the id; this writes
   * that fact into the shared tracker, where the other machine's `withoutLeases` reads
   * it, and takes it back out when the window goes. Plus the in-app terminals, which are
   * the same fact from a register rather than an inference — and the one door a name
   * cannot speak for, because that brief tells the session not to rename itself.
   *
   * **The release is what made this a bead rather than a line.** A hand-opened window is
   * not a worker: no slot, no `reconcile`, nothing that would ever renew or drop its
   * claim. Staking one with only `leaseMinutes` to end it would park that bead on every
   * other Mac for an hour after you closed the window — which is the trade lib/lease.js
   * calls strictly worse than the duplicate it prevents, and the reason the first attempt
   * at this stopped and asked rather than shipping it. The window itself is the answer,
   * and it is free: it arrives every tick in the same snapshot every other filter here
   * reads. So the claim follows it — staked while a session names the bead, renewed at
   * half life for as long as one does, and taken off on the first tick after the last one
   * has gone. Expiry stays underneath for the one case this cannot see, a daemon that was
   * down when the window closed, which is exactly what `leaseMinutes` is for.
   *
   * Off with `holdLeases: false` because it is a lease, and off with
   * `holdLiveSessions: false` as well because a window is the only evidence it has: an
   * advocate told not to treat an open window as a bead being worked has no business
   * telling the other machines that it is.
   *
   * **Three windows it deliberately says nothing about.** A **worker** — or a window on a
   * bead beneath one — because `launch` and `reconcile` already stake, renew and release
   * that claim, and two mechanisms on one bead is two labels to sync and a bead that
   * reads as contested by one machine. A window whose name **says `QUEUED-` or `DONE-`**,
   * because a session finished by its own account is not working the bead and its
   * window may sit there for an hour afterwards — and since bc-r941 the first of those
   * is the prefix a worker actually writes, the second arriving later from the merge
   * queue (lib/retitle.js). And a bead **another Mac already holds**, because a
   * later claim of ours loses the tiebreak anyway, and writing one would only tell the
   * holder's card the bead is contested when nothing here is going to stand down: this
   * window is a person at a keyboard, and no advocate closes one of those.
   */
  async function leaseHandOpened(a, sessions) {
    if (!leasing() || o.holdLiveSessions === false || OBSERVING) return;

    // One entry per bead rather than per session: two windows on one bead is a real state
    // on this Mac — bc-vq78 is what happens next — and it is one claim either way.
    const open = new Map();
    // The edges rather than the id, for the reason every other subtree question here uses
    // them (bc-b2k.2): a window on a bead *adopted* under a worker's bead is one `launch`
    // has already staked, and reading it as unclaimed writes a second label onto a bead this
    // Mac is holding twice over. Off this tick's export; `null` falls back to the id.
    const parents = await tickParents(a);
    const held = (id) =>
      a.workers.some((w) => w.id === id || underEpic(id, w.id, parents)) || a.closing.some((c) => c.id === id);
    for (const s of sessions) {
      if (saidFinished(s.name)) continue;
      const id = beadInName(s.name);
      if (!id || open.has(id) || held(id)) continue;
      open.set(id, { where: `pid ${s.pid}` });
    }
    /**
     * And the door a window's *name* can never speak for. An in-app terminal seeded on a
     * bead is briefed for a phone-sized screen and told outright **not to rename itself**
     * (`terminalPrompt`, lib/session.js), so no session record will ever carry its id and
     * the loop above is blind to every one of them.
     *
     * It does not need a name. This daemon owns the pty, so `live` is not an inference
     * from a process table — it is the register that starts and ends it. **`live` only**:
     * a `resumable` terminal is a conversation waiting to be picked up, with no process
     * behind it and possibly days before anybody does, and a claim held across that is
     * exactly the park lib/lease.js calls worse than the duplicate window it prevents.
     */
    for (const t of terminals() || []) {
      const id = t?.bead?.id;
      if (!id || t.status !== 'live' || t.workspace !== a.name) continue;
      if (open.has(id) || held(id)) continue;
      open.set(id, { where: `terminal ${t.id}` });
    }

    // The release, first, so a window that closed between ticks is not still holding a
    // bead while the loop below decides whether to renew it.
    for (const [id, record] of a.handLeases) {
      if (open.has(id)) continue;
      a.handLeases.delete(id);
      if (!record.lease) continue;
      await unstake(a, id, record.lease.label);
      console.log(`[advocate] ${a.name}: released ${id} — the window that had it open has gone`);
    }

    for (const [id, window] of open) {
      const known = a.handLeases.get(id);
      // Nothing to do until a claim is halfway through its life, and the same clock for a
      // bead we looked at and did *not* claim — which turns a `bd show` per window per
      // tick into one per window per half life. The negative answers age rather than
      // stick because every one of them can change: a closed bead reopens, another Mac's
      // claim lapses, a `bd` that would not answer answers.
      if (known && !renewDue(known.lease || { at: known.at }, leaseOpts())) continue;

      let issue = null;
      try {
        issue = await bd.show(a.workspace, id);
      } catch {
        // A tracker that will not answer is not evidence about anything. Leave the record
        // as it was — including absent, so a first sighting is retried on the next tick
        // rather than waiting out half a lease.
        continue;
      }
      const at = iso();
      // Not a bead in this workspace at all, which is the ordinary answer for a
      // hyphenated word in a window title, or one nothing should be claiming.
      if (!issue || issue.status === 'closed') {
        a.handLeases.set(id, { lease: null, at });
        continue;
      }

      const v = leaseVerdict(issue.labels || [], me, leaseOpts());
      if (v.lost) {
        if (!known) console.log(`[advocate] ${a.name}: ${id} is open in a window here, and ${describeLease(v.holder)}`);
        a.handLeases.set(id, { lease: null, at });
        continue;
      }
      // Already ours and still good: a claim this daemon wrote before it restarted, or one
      // `launch` wrote for a worker whose slot has since gone while the window stayed. It
      // is adopted rather than written over, because a second label from the same handle
      // is a second row to sync and a bead `leaseVerdict` reports as contested.
      if (v.mine && !renewDue(v.mine, leaseOpts())) {
        a.handLeases.set(id, { lease: v.mine, at });
        continue;
      }

      const label = await stake(a, id);
      // `stake` says why it failed and the failure is not fatal to anything: the bead is
      // simply unclaimed for now, and the record's timestamp is what stops a `bd` that is
      // refusing everything from being asked again every thirty seconds.
      a.handLeases.set(id, { lease: label ? leasesOf([label])[0] || null : null, at });
      if (!label) continue;
      // The old one comes off only once the new one is written, the same order and for the
      // same reason as the worker's restamp above.
      if (v.mine && v.mine.label !== label) await unstake(a, id, v.mine.label);
      if (!known?.lease) {
        console.log(`[advocate] ${a.name}: claimed ${id} for ${me} — a window here has it open (${window.where})`);
      }
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

  /** How many windows one bead may cost before this advocate stops offering it any. */
  const attemptCap = () => clampInt(o.maxAttemptsPerBead, 1, 10, DEFAULTS.maxAttemptsPerBead);

  /**
   * The checkout a queued bead's `.beadcause/relays.yaml` would be read out of, or `''`.
   *
   * `bead.repo` is the name `placeFor` already resolved during the survey, so this is a
   * lookup rather than a second resolution — the queue row, the launch and this all name
   * one directory or they can disagree about which file a definition came from. A
   * single-repo workspace has one checkout and the row carries no name; a workspace with no
   * checkout on disk at all — a scratch tracker under `~/beads` — has none, and `''` reads
   * downstream as "no definition here", which is the correct answer rather than an error.
   *
   * The list is passed in rather than asked for, because the caller is in a loop: `repoDirs`
   * resolves a directory for a single-repo workspace on every call, and once per ready bead
   * per pass over the queue is several hundred resolutions a minute to answer the same
   * question.
   */
  function checkoutFor(dirs, bead) {
    if (!dirs.length) return '';
    if (!bead?.repo) return dirs[0]?.dir || '';
    return dirs.find((r) => r.name === bead.repo)?.dir || '';
  }

  /**
   * **Which department each of these beads is in, and what its checkout says about it** —
   * `[{ id, dept, capacity }]`, in the order handed in, plus one sentence per checkout whose
   * definition would not parse.
   *
   * ## The department comes from the graph, and it could not have come from the row
   *
   * A relay is keyed off the bead's **assignee**, and `bd ready --json` has no `assignee`
   * field — not one this survey drops, one the payload does not contain. The queue row
   * carries id, title, priority, type, two timestamps, labels and the repo, and that is all
   * there has ever been. So a filter reading the row could see a `dept:` label and nothing
   * else, which would be a ceiling that applied to the beads somebody had happened to label
   * and silently not to the rest — the same fact spelled two ways, which is what this whole
   * family exists to stop.
   *
   * `a.tickGraph` is where the assignee is, it is one `bd export` per tick, and it is
   * already paid for by the roster and the pause set. `givenUp` a few lines up reads
   * `row.assignee` out of it in exactly this shape, and the failure direction is copied from
   * there deliberately: **a graph that did not answer this tick means no cap, not an empty
   * one.** The other reading — treat a silent tracker as "no departments, so nothing is
   * under a ceiling" — happens to be the same answer here, but the one that matters is the
   * shape: a subtraction must never grow because a read failed.
   *
   * ## And the labels come from the row, which is the other way round on purpose
   *
   * Both rows carry labels and they are not the same list: the graph's are the export's, and
   * the queue row's are `bd ready`'s — the newer read of the two, by up to a minute. A
   * `relay:` or `dept:` label added inside that minute is the case where they differ, and
   * the queue's copy is the one that keeps a bead from routing under yesterday's department
   * for a tick. So the assignee is taken from the graph because it is the only place it
   * exists, and the labels from the row because it is the fresher of two places that have
   * them.
   */
  function departmentsOf(a, beads) {
    const rows = a.tickGraph?.beads || null;
    const dirs = repoDirs(a);
    const { seen, problems } = departmentsFor(
      cfg,
      a.name,
      beads.map((bead) => ({
        id: bead.id,
        dir: checkoutFor(dirs, bead),
        // `''` where the graph would not answer this tick, which is what makes the whole
        // pass answer `null` for every department below without a second branch to keep in
        // step: no assignee is no role, no role is no chain, and no chain is no ceiling.
        assignee: rows ? rows.get(bead.id)?.assignee || '' : '',
        labels: bead.labels || [],
      }))
    );
    // A checkout's definition is still read, and still reported, when the graph is silent:
    // a file that will not parse is a fact about a directory and owes nothing to the
    // tracker. Only the *cap* is given up on, which is the safe direction.
    return { seen, problems: problems.map((p) => ({ why: p.why, id: p.id, repo: repoNameFor(a, p.dir) })) };
  }

  /** Beads this advocate may open a window on, in the order it would take them. */
  function candidates(a) {
    const busy = new Set(a.workers.map((w) => w.id));
    const settle = clampInt(o.settleSeconds, 0, 3600, DEFAULTS.settleSeconds);
    const maxAttempts = attemptCap();
    const ready = a.queue
      .filter((b) => !busy.has(b.id))
      .filter((b) => (a.attempts[b.id] || 0) < maxAttempts)
      // A bead is often still being written a few seconds after it appears — a
      // session that grabs it mid-sentence works from half a description.
      .filter((b) => secsSince(b.updatedAt) >= settle)
      .sort(byPickOrder);

    // And the fourth, which is the only one of the four that another repo gets a say in.
    // **After** the three above and never before them, which is what keeps the two lists it
    // writes honest: a bead already at `maxAttemptsPerBead` is `givenUp`'s to report and a
    // bead inside `settleSeconds` is settling, and either one named here as well would be
    // one bead drawn as two pills — and would be subtracted twice from the arithmetic on the
    // "N ready · M settling" line. Sorted first, too, because the ceiling is spent in pick
    // order: which bead of a full department gets the last window is a question with an
    // answer, and it is the same answer the tick would have given without a ceiling at all.
    const { seen, problems } = departmentsOf(a, ready);
    // What was said last time, which is deliberately **not** the card's own list: that one
    // is emptied at the top of every tick so a paused advocate stops drawing a stale hold,
    // and a "have I said this already" guard built on it would answer no every thirty
    // seconds for as long as the file stayed broken. Two fields, because they are two
    // questions — what is true now, and what has already been printed.
    const saidProblem = new Set(a.saidRelayProblem || []);
    a.relayProblems = problems;
    a.saidRelayProblem = problems.map((p) => p.why);
    for (const p of problems) {
      // Once per checkout per spell of being broken, the way `withoutUnplaceable` says a
      // `repo:` token nothing declares: a file broken on Friday is otherwise 2,880 identical
      // lines by Saturday. Deliberately **not** `repoList().warnings`, which reads well and
      // is read by nobody — the pattern that actually reaches a surface is a sentence on the
      // record plus one guarded line, and that is what this is.
      if (!saidProblem.has(p.why)) console.log(`[advocate] ${a.name}: ${p.why} — dispatching without a relay`);
    }
    const titles = new Map(ready.map((b) => [b.id, b.title || '']));
    const { kept, held } = withinCapacity(seen, { open: a.workers.map((w) => w.dept || null) });
    const heldBefore = new Set(a.saidDept || []);
    a.heldByDept = held.map((h) => ({ ...h, title: titles.get(h.id) || '' }));
    a.saidDept = held.map((h) => h.id);
    for (const h of held) {
      if (!heldBefore.has(h.id)) console.log(`[advocate] ${a.name}: ${h.id} — ${h.why}`);
    }
    const keep = new Set(kept.map((k) => k.id));
    return ready.filter((b) => keep.has(b.id));
  }

  /**
   * The beads in the queue this advocate will never open a window on again.
   *
   * The other half of `candidates`'s attempt filter, and the only subtraction in this
   * file that used to be reported by nobody. Every `heldBy*` list above names a bead the
   * survey took *out* of the queue and says why; this one names a bead that is still in
   * it — counted in `queue`, drawn on the card, sitting in `bd ready`, indistinguishable
   * from work about to be picked up — and that no tick will ever pick up, because
   * `maxAttemptsPerBead` is a floor nothing decrements. The counter is cleared on the
   * four endings that are not failures (`closed`, `delivered`, `handback`, `stood down`)
   * and on nothing else, so two windows that die without reaching one of them retire the
   * bead permanently: `2 < 2` is false, forever.
   *
   * bc-xl7n.111 is what that costs when it is silent. bc-xl7n.37 was read as healthy by
   * five consecutive Epic Advocate passes — "queued behind a busy Mac, not stalled" — and
   * each reading was reasonable, because the only line that ever mentioned the state
   * welded it to a thirty-second settle (`3 ready · 3 settling or already tried`) and
   * named no ids. It cost that bead a committed, passing, never-pushed test suite: its
   * second window had the work on disk when it died, and there is no third.
   *
   * **Not a defect to be fixed by raising the cap or clearing it on a dead window.** A
   * bead that kills two windows should stop taking them; the cure is `forget` on the
   * console (`control`), which is one press and already shipped. What was missing is the
   * *diagnosis* — that the count is non-zero, and which beads it is holding — which is
   * why this is a list with ids on it rather than a number.
   *
   * `busy` is subtracted for the same reason `candidates` subtracts it: a bead with a
   * window open on it right now is at its second attempt and being worked, and reporting
   * it as given up on would name the one case where another window is the last thing
   * anybody wants.
   *
   * **And the half that is not in the ready queue at all — bc-xl7n.117.** Everything
   * above is computed over `a.queue`, so the list answers only for a bead that is
   * *ready*; a bead that is retired **and claimed** is in neither the dispatcher's queue
   * nor this report, which is exactly the population a delivery lands in. bc-xl7n.87 sat
   * there while the tick note named three other beads: two advocate windows had timed out
   * and charged it, the pull request was then made by hand, and `Request changes` on its
   * card would have handed it back to a dispatcher that had already retired it. So the
   * counters are walked too, and a bead at the cap that the tracker says is claimed is
   * named beside the ready ones with `claimed` on it.
   *
   * **Only what the graph can vouch for**, and that is the whole of what keeps this from
   * becoming noise: nothing decrements `a.attempts`, so a counter outlives the bead it
   * was charged to, and a list built from the map alone would name last week's closed
   * work for ever. The tick's own export (`tickGraph`, one `bd export` a tick and already
   * paid for) is what answers, and a bead it has no row for — closed, or a tracker that
   * would not answer this tick — is left out. A minute of staleness on the graph cache
   * costs at worst one tick naming a bead that has just closed, which is the safe
   * direction: the other one is silence.
   */
  function givenUp(a) {
    const busy = new Set(a.workers.map((w) => w.id));
    const cap = attemptCap();
    const why = (n, tail) =>
      `${n} window(s) ended without delivering, and maxAttemptsPerBead is ${cap} — nothing here will open another.${tail} Forget attempts re-arms it.`;
    const ready = (a.queue || [])
      .filter((b) => !busy.has(b.id))
      .filter((b) => (a.attempts[b.id] || 0) >= cap)
      .map((b) => ({
        id: b.id,
        title: b.title || '',
        attempts: a.attempts[b.id] || 0,
        claimed: false,
        why: why(a.attempts[b.id] || 0, ''),
      }));
    const inQueue = new Set((a.queue || []).map((b) => b.id));
    const rows = a.tickGraph?.beads || null;
    if (!rows) return ready;
    const claimed = [];
    for (const [id, n] of Object.entries(a.attempts || {})) {
      if ((n || 0) < cap || busy.has(id) || inQueue.has(id)) continue;
      const row = rows.get(id);
      // Claimed, and still open: `in_progress` is what a worker's first act writes, and
      // an assignee on a bead the queue cannot see is the same state under another
      // status. Anything else out of the queue — blocked, deferred, held by a label, held
      // by any of the ten subtractions above — is already reported by whatever is holding
      // it, and naming it here as well would be two pills for one bead.
      if (!row || row.status === 'closed') continue;
      if (row.status !== 'in_progress' && !row.assignee) continue;
      claimed.push({
        id,
        title: row.title || '',
        attempts: n || 0,
        claimed: true,
        why: why(n || 0, ' It is claimed rather than ready, so it is not in the queue either, and handing it back does not re-arm it on its own.'),
      });
    }
    return [...ready, ...claimed];
  }

  /**
   * The fragment that says so, on whichever note this tick ends up writing.
   *
   * Appended rather than given a line of its own, and appended to *every* note that
   * describes a non-empty queue rather than only to the one that explains an empty one —
   * because unlike the nine holds above, this state cannot be inferred from the shape of
   * the tick. A tick that opens two windows while a third bead is retired for ever looks
   * exactly like a tick that opens two windows, and the retired bead is the one that will
   * still be there tomorrow. `deferredNote` is on that line for the same reason.
   *
   * The ids are in it because the count on its own is the number this bead was filed
   * about: "2 settling" sent five passes to read `bd ready`, and two of them re-derived
   * the same wrong answer. Three ids and a remainder — enough to go and look, short
   * enough for a card.
   */
  function gaveUpNote(a) {
    const gone = givenUp(a);
    if (!gone.length) return '';
    const ids = gone.slice(0, 3).map((g) => g.id).join(', ');
    const more = gone.length > 3 ? `, +${gone.length - 3} more` : '';
    return ` · ${gone.length} given up on after ${attemptCap()} attempt(s) (${ids}${more})`;
  }

  /**
   * The same fragment for a full department — bc-ogicx.6.
   *
   * Appended to every note that describes a non-empty queue, for the reason `gaveUpNote`
   * and `deferredNote` are and not for the reason the ten counted into `quiet` are: this
   * hold subtracts from `candidates` and not from `a.queue`, so it can never be the thing
   * that empties the queue and its sentence would never be reached on the line that
   * explains one. What it *can* do is be invisible — a tick opening two windows while a
   * third bead waits on a ceiling looks exactly like a tick opening two windows.
   *
   * The department is named and the ids are not, which is the opposite choice from
   * `gaveUpNote` and the right one here: what a reader has to know is *which department*,
   * because that is where the number they would change is written, and the beads waiting on
   * it are whichever ones the queue happens to hold this minute. The list on the card
   * carries the ids and the sentence for each.
   */
  function deptNote(a) {
    const held = a.heldByDept || [];
    if (!held.length) return '';
    const depts = [...new Set(held.map((h) => h.dept))];
    const which = depts.slice(0, 2).join(', ');
    const more = depts.length > 2 ? `, +${depts.length - 2} more` : '';
    return ` · ${held.length} waiting on a busy department (${which}${more})`;
  }

  /**
   * And the checkout whose own definition would not parse — bc-ogicx.6, and **not a hold**.
   *
   * The distinction is the entire content of this line and it is why the sentence is here
   * rather than in a `heldBy*` list: a repo whose `.beadcause/relays.yaml` is broken
   * dispatches every one of its beads exactly as it did before the file existed, without a
   * relay. Nothing is waiting. What was missing is that nothing said so — the launcher
   * carries the sentence as far as `relayProblem` and stops, which test/relaywiring.mjs
   * pins by name, and a definition silently ignored is a repo that believes it has
   * departments and has none.
   *
   * One sentence whatever the number of broken checkouts, because the log line beside it
   * already names each one and a tick note is one line on a card.
   *
   * And **trimmed from the end**, which is the one choice here worth arguing. Two of
   * lib/relaydefs.js's refusals run past two hundred characters, because they are written
   * for somebody looking at a file they wrote and needing to know which line — the right
   * length for a log and for a tooltip, and the wrong length for a card. Every one of them
   * opens with the filename and the fault and explains itself afterwards, so cutting the
   * tail costs the argument and never the diagnosis; the whole sentence is on the pill and
   * in the log, and the note's job is to say that there *is* one.
   */
  const NOTE_LIMIT = 140;
  function relayNote(a) {
    const problems = a.relayProblems || [];
    if (!problems.length) return '';
    if (problems.length > 1) {
      return ` · ${problems.length} checkouts have a relay definition that will not load — dispatching without one`;
    }
    const why = problems[0].why || '';
    const said = why.length > NOTE_LIMIT ? `${why.slice(0, NOTE_LIMIT - 1).trimEnd()}…` : why;
    return ` · ${said} (dispatching without a relay)`;
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

    // What the survey is told about the gap between its `bd ready` and my queue — see
    // `queueBrief`. Two extra `bd` calls, and they are free where lib/work.js's are not:
    // that screen refreshes every twenty seconds and this runs at most once per
    // `proposeCooldownHours` (twelve by default), immediately before a ten-minute agent.
    //
    // Both are allowed to fail, and a failure costs the paragraph its numbers rather than
    // the survey its run. `null` and `0` are kept apart all the way down for the same
    // reason: "nothing is waiting on you" is a claim, and "I could not ask" is not.
    const counts = { owner: ownerName(cfg) };
    try {
      counts.heldForEndorsement = (await bd.readyHeld(a.workspace)).length;
    } catch (err) {
      console.error(`[advocate] ${a.name}: surveying without an endorsement count — ${err.message.split('\n')[0]}`);
    }
    try {
      counts.shipWaiting = bd.readyShip ? (await bd.readyShip(a.workspace)).length : null;
    } catch (err) {
      console.error(`[advocate] ${a.name}: surveying without a ship count — ${err.message.split('\n')[0]}`);
    }

    a.surveying = true;
    emit(a, 'surveying', { detail: 'looking for work worth proposing' });
    try {
      const surveyed = await surveyAgent(a, counts);
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
      // The card has to be *seen* — bc-rfnr.2's inbox draws only what descends from a root
      // you own, so a parentless proposal is an advocate asking a question on a screen
      // that will not show it. Nothing discovered this one, so it lands in the unsorted
      // backlog; a tracker with no such root files it exactly where it did. lib/homing.js.
      const { parent } = await homeIn(bd, a.workspace, {});
      const id = await bd.create(a.workspace, {
        title: proposalTitle(a.name, beads),
        body: proposalBody(a.name, beads),
        priority: 2,
        type: 'task',
        parent,
        // CARD_LABEL (lib/card.js, bc-7qo.9): approving creates the *named* beads —
        // nothing is ever built for the proposal bead itself, only for what it spawns.
        labels: ['human', PROPOSAL_LABEL, CARD_LABEL],
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
  async function surveyAgent(a, counts = {}) {
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

    // The advocate's foundation comes from the repo it advocates for, not from
    // beadcause's own checkout: an amendment is per agent kind, but it is stored
    // wherever that agent runs, so a repo can carry a differently-scoped advocate.
    //
    // Read *before* the log is reset rather than after, which is the whole of why it moved
    // up: the archive of the run being replaced records which model that run proceeded
    // under (bc-eqn1.7), and this is where that answer is.
    const f = await effective(dir, 'advocate');

    // The previous survey is archived and chained before it is cleared — never
    // `agentlog.reset`, see the note on it. A survey is keyed on the workspace rather than
    // a bead, so `bead` is null: the word "advocate" in a bead field is a bead id nothing
    // can look up.
    const kept = await archiveAndReset(key, {
      cfg,
      dir,
      workspace: a.name,
      bead: null,
      agent: 'advocate',
      model: f.model || null,
      endorsed: true,
      endorsementNote: 'a survey is the advocate doing its own job, not work opened on a bead',
    });
    if (kept.archived && !kept.chained) console.error(`[agentlog] ${key}: kept but unchained — ${kept.reason}`);

    agentlog.append(
      key,
      `● surveying ${a.name} in ${dir}${others.length ? ` and ${others.length} other checkout(s)` : ''}`
    );

    // Tier 3: the private repo, its grant, and which arm of the experiment this run is.
    //
    // Provisioned here rather than at startup because the path carries the workspace and
    // this is the moment both halves are known. Everything about it is wrapped, because
    // an advocate that cannot survey a repo because its *diary* would not initialise is
    // a worse outcome than an experiment with a gap in it — the survey is the job, this
    // is the experiment riding along with it.
    let repo = null;
    try {
      repo = await agentrepo.startRun(f, a.name, { setting: o.agentRepo, owner: ownerName(cfg) });
      if (repo) {
        // The grant is added to the effective foundation rather than baked into the
        // baseline, for the reason `grantsFor` gives: the concrete path is per-run and
        // a foundation is what the agent is on every run.
        f.allowedTools = [...(f.allowedTools || []), ...repo.grant.allowedTools];
        agentlog.append(key, `● tier 3: own repo, ${repo.arm} arm`);
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
        checkoutBrief(a, dir, others),
        queueBrief(a, o, { owner: ownerName(cfg), ...counts })
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
        env: agentEnv(f, repo?.grant.env || {}, cfg),
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
   * What a finished session actually ran on and what it cost, written onto its bead
   * (bc-nc6o.3 and bc-nc6o.8).
   *
   * Separate from the archive below and deliberately not gated on `sessionLog`: the log
   * is a convenience this workspace may have turned off, and what an hour of unattended
   * work was billed to is a fact about the bead. `ran:<model>` is a set, so a second run
   * on the same model is no write at all and a bead worked twice on two models keeps
   * both — see lib/ranmodel.js. `ctx:<verdict>` is a set for the same reasons, and a bead
   * that fitted once and overflowed later keeps both, which is the most useful pair the
   * tracker can hold about it: the work grew and the tier did not.
   *
   * **Both labels off one `bd show`.** They are two answers about the same finished
   * session, and reading the row twice to write them would be two round trips and a window
   * in which the second write is computed against a row the first one changed.
   *
   * Silent about the ordinary cases, and there are three of them. A session with no
   * transcript left says nothing rather than guessing the routed model, a run that went
   * where it was sent says nothing either, and a run that fitted its window comfortably
   * says nothing beyond its label. **A divergence and an overflow are said out loud,
   * once** — those two are news: the first is the case both cards exist to show, and the
   * second is an unattended hour that spent part of itself compacting, which is the thing
   * the tier was supposed to prevent.
   */
  async function recordRun(a, worker, models, tokens) {
    const pressure = tokens?.pressure || '';
    if (!models?.length && !pressure) return;
    // Computed against the row rather than applied blind, the way every other label write
    // here is: a bead re-archived, or worked a second time on the same model, is then no
    // `bd` write at all rather than a no-op edit in its history.
    let row = null;
    try {
      row = await bd.show(a.workspace, worker.id);
    } catch (err) {
      console.error(`[advocate] ${a.name}: could not read ${worker.id} to record what it ran on — ${err.message.split('\n')[0]}`);
      return;
    }
    const addLabels = [...ranUpdate(row, models).addLabels, ...ctxUpdate(row, pressure).addLabels];
    for (const label of addLabels) {
      try {
        await bd.addLabel(a.workspace, worker.id, label);
      } catch (err) {
        console.error(`[advocate] ${a.name}: could not record ${label} on ${worker.id} — ${err.message.split('\n')[0]}`);
      }
    }
    if (ranDiverged(worker.model, models)) {
      console.log(
        `[advocate] ${a.name}: ${worker.id} was opened on ${worker.model} and ran on ${models.join(', ')}`
      );
    }
    // Said once, and only for the verdict nobody can act on without being told: a bead
    // routed to a window it did not fit. The line carries the numbers because "it
    // overflowed" on its own is not enough to re-rate anything — how close a 200k session
    // came, and how much it had to drop, is the difference between a tier that is one step
    // out and a bead that needs the long window.
    if (pressure === 'over') {
      console.log(
        `[advocate] ${a.name}: ${worker.id} ran out of context on ${worker.model || 'an unrecorded model'}` +
          `${worker.tier ? ` (rated ${worker.tier})` : ' (unrated)'} — ${tokenLine(tokens)}`
      );
    }
  }

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
    // Observing writes nothing anywhere: an archive is a git ref and a note on somebody
    // else's commits, in a checkout this instance is only visiting, and a `ran:` label is
    // a row in a tracker this instance does not own.
    if (OBSERVING) return;

    /**
     * The bead's own copy of what ran, when the archive is not going to produce it.
     *
     * With `sessionLog` on — the default — the archive reads each transcript anyway and
     * hands the models back, so this branch is not taken and the file is read once. With
     * it off there is no archive to read them off, and the models are still owed: the
     * label is the only place the answer would survive the window closing.
     */
    if (!o.sessionLog) {
      for (const { worker } of finished) {
        // One read of the transcript for both answers — see `ranFactsOf`. The verdict is
        // graded here rather than in that function because the window comes off the
        // *selection* the launcher used, which only this side knows.
        const { models, usage } = ranFactsOf(worker.sessionId || null);
        await recordRun(a, worker, models, sessionTokens(usage, worker.model || null));
      }
      return;
    }

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
      // What the archive read off the transcript, so the label below can be written from
      // it rather than reading the same megabytes a second time. Null means the archive
      // did not get that far — no checkout to write into, or it threw — and the label
      // falls back to reading the transcript itself, because an archive that failed is
      // precisely when the bead is the only place this fact can survive.
      let ran = null;
      let tokens = null;
      try {
        if (!dir) throw new Error('no checkout to archive into');
        const res = await archiveSession(dir, {
          workspace: a.name,
          bead: worker.id,
          title: worker.title,
          sessionId: worker.sessionId || null,
          startedAt: worker.at,
          outcome,
          includeTranscript: withTranscript,
          // What it was routed to, so `meta.json` carries the plan beside the outcome and
          // a reader three months from now can tell "opus because somebody rated it hard"
          // from "opus because nobody rated it at all" (bc-nc6o.2, bc-nc6o.3).
          model: worker.model || null,
          tier: worker.tier ?? null,
        });
        ran = res.ran;
        tokens = res.tokens;
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
        /**
         * And the one bead that entry will never reach — bc-xl7n.102.
         *
         * `notePending` writes when the branch lands in main, which for a bead just handed
         * back to the queue is never: nothing will push it, because the bead is workable
         * again and the next window opens a fresh worktree. So this is the moment those
         * facts stop being recoverable, and it is the last moment anything holds them.
         *
         * Four conditions and each is doing work. `handedBack` is what makes this one of
         * the endings nobody chose — `delivered`, `handback` and `done` all keep the claim
         * and all have somewhere the work is already written down. `commits.length` is what
         * makes there be anything to say: a window that died having built nothing leaves
         * nothing, which is the honest answer. And `!merged` is what keeps this off work
         * that is already in main.
         *
         * **`!parkedForResume` is the fourth, and it is what bc-y7l2m added.** Every word
         * of the paragraph above rests on "the next window opens a fresh worktree", and for
         * a conversation parked because its window disappeared that is now false: the same
         * agent comes back to the same tree, on the same branch, holding the same commits.
         * Salvaging them would post a comment telling that agent, about its own work, that
         * its dead window built something — and the comment outlives the trip, so it is
         * still there being read as a fact about an abandoned branch long after the branch
         * was picked back up. Nothing is lost by staying quiet: the archive under
         * `refs/beadcause/sessions/<bead>` is still written either way, which is the actual
         * record. This only drops the courtesy note to a stranger who is not coming.
         *
         * Written after the archive rather than in `handBack` because `handBack` runs inside
         * `reconcile`, where none of these facts exist yet — the branch and its commits are
         * `archiveSession`'s answer, and it has not been called. The bead is back in
         * `bd ready` for the seconds in between, which is the same tick and is why the
         * comment still beats the window that reads it.
         *
         * A failure here is logged and dropped. The archive is the record; the comment is a
         * courtesy to the next window, and a tracker that will not take it must not cost the
         * rest of the finished list its archive.
         */
        if (worker.handedBack && !worker.parkedForResume && res.head && !res.merged && res.commits.length) {
          try {
            const said = await salvageNote(dir, {
              bead: worker.id,
              ref: res.ref,
              branch: res.branch,
              head: res.head,
              worktree: res.worktree,
              commits: res.commits,
            });
            if (said) {
              await bd.comment(a.workspace, worker.id, said);
              console.log(
                `[advocate] ${a.name}: told ${worker.id} what its dead window built` +
                  ` — ${res.commits.length} commit(s) on ${res.branch}`
              );
            }
          } catch (err) {
            console.error(
              `[advocate] ${a.name}: could not tell ${worker.id} what its dead window built — ${err.message.split('\n')[0]}`
            );
          }
        }
        /**
         * And the one agent in this repo whose trigger is a session *ending* — bc-dgx7.1.
         *
         * Here rather than in the poll cycle because this is the only place that knows
         * which checkout the archive just landed in: a workspace holding forty repos has
         * no directory of its own, and a sweep would have to re-derive per repo what this
         * loop was handed. After the ref, never before — the audit reads the archive, so
         * nudging it first would be asking it to read a commit that does not exist yet.
         *
         * `noteArchive` starts a run and returns; it never throws and is never awaited,
         * because what is around this is a tick that opens sessions.
         */
        audit?.noteArchive?.({ dir, workspace: a.workspace, bead: worker.id });
      } catch (err) {
        // A workspace with no resolvable checkout has nothing to say here — it is the
        // ordinary state of one that is not on this Mac — so only a real failure is
        // logged, and the label is still written from whatever the transcript says.
        if (dir) console.error(`[advocate] ${a.name}: could not archive ${worker.id} — ${err.message.split('\n')[0]}`);
      }
      // After the ref, for the reason the debrief is cleared after it: a label saying a
      // session ran is a claim about a record, and it should not land before the record.
      //
      // `ran` null means the archive did not get that far, and then the transcript is read
      // here for both halves at once — which is exactly the moment the bead is the only
      // place either fact can survive.
      if (ran) {
        await recordRun(a, worker, ran, tokens);
      } else {
        const { models, usage } = ranFactsOf(worker.sessionId || null);
        await recordRun(a, worker, models, sessionTokens(usage, worker.model || null));
      }
    }
  }

  /**
   * Note the commit that finally brought an archived session's branch into main.
   *
   * Cheap enough to run on every sweep: one `merge-base --is-ancestor` per pending
   * entry, and there are normally none.
   */
  /**
   * The requirements corpus this advocate can see, or an empty one.
   *
   * Derived from the repos this advocate already works in rather than from a constant:
   * the corpus lives in `resources/reqs` inside the architecture checkout, and that
   * checkout is one of the approved repos for the workspace that needs it. So a personal
   * workspace finds nothing and every requirement path switches itself off, without a
   * flag and without a per-machine path in the repo.
   *
   * `loadCorpus` caches on the files' own mtimes, so calling this per landing is a
   * handful of `stat`s and not 34 file reads.
   */
  function corpusFor(a) {
    const dir = corpusDir(
      cfg,
      repoDirs(a).map((r) => r.dir)
    );
    return dir ? loadCorpus(dir) : null;
  }

  /**
   * What a landing has to say about requirements and controls — and what it owes when it
   * says nothing.
   *
   * Both halves, in one function and in one place, because both need the same three facts
   * at the same moment — the merge commit, the bead, and the files that merge touched —
   * and because they write into **one** note. A landing note has one `files:` line because
   * a landing has one diff; lib/controllanding.js owns the composition and is handed the
   * requirements half's `extra` rather than producing a second fragment beside it.
   *
   * The two halves switch off independently and for different reasons. Requirements need a
   * corpus this Mac may not have, so the whole of that half is skipped when there is none —
   * which is every personal install. Controls need no checkout at all: lib/controls.js
   * ships with beadcause, so that half runs everywhere and does nothing whenever the bead
   * claims no control, which is most beads.
   *
   * Wrapped here rather than inlined at the call site because the sweep must not be able
   * to fail on this: a landing whose evidence could not be recorded is still a landing,
   * the note is still written, and the index is rebuildable from the note. Everything
   * below is best-effort by construction and returns `{ extra: '', ids: [], controls: [] }`
   * when it cannot do its job.
   */
  async function evidenceAtLanding(a, main, sha, beadId) {
    const none = { extra: '', ids: [], controls: [] };
    try {
      const issue = await bd.show(a.workspace, beadId).catch(() => null);
      let extra = '';
      let ids = [];
      let files = [];
      const corpus = corpusFor(a);
      if (corpus?.ids?.size) {
        const res = await recordLanding({ main, sha, bead: beadId, workspace: a.name, issue, corpus });
        if (res.error) console.error(`[advocate] ${a.name}: ${beadId} requirement index — ${res.error}`);
        if (res.glean && !OBSERVING) {
          const marked = await markForGlean(bd, a.workspace, beadId, issue, { commit: sha, files: res.files }).catch(
            () => false
          );
          if (marked) console.log(`[advocate] ${a.name}: ${beadId} landed naming no requirement — flagged to glean`);
        }
        extra = res.extra;
        ids = res.ids;
        files = res.files;
      }
      // bc-eqn1.3: the claim a bead made about a control becomes proof here, because this
      // is the moment a merge commit and a bead are both in hand. Nobody has to remember.
      const ctl = await recordControlLanding({
        main,
        sha,
        bead: beadId,
        workspace: a.name,
        issue,
        base: extra,
        files,
      });
      if (ctl.error) console.error(`[advocate] ${a.name}: ${beadId} control index — ${ctl.error}`);
      // Said out loud rather than discarded: an agent that is not told writes the same
      // invented control every run, and from outside that is indistinguishable from the
      // feature not working. lib/beadcontrols.js makes the argument at length.
      if (ctl.dropped.length) {
        console.error(
          `[advocate] ${a.name}: ${beadId} named ${ctl.dropped.join(', ')}, which the control corpus does not have`
        );
      }
      return { extra: ctl.extra, ids, controls: ctl.ids };
    } catch (err) {
      console.error(`[advocate] ${a.name}: ${beadId} evidence at landing — ${err.message.split('\n')[0]}`);
      return none;
    }
  }

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
        // bc-fvmx and bc-eqn1.3: the one moment a merge commit and a bead are both in
        // hand. What the bead said it fulfils, and what it said it exercises, become
        // evidence here — on the note, which is immutable, and in the two indexes, which
        // are rebuilt from the note when they are wrong. A repo with no requirements
        // corpus takes none of the first half; a bead claiming no control takes none of
        // the second; a bead with neither gets the note it always got.
        const ev = await evidenceAtLanding(a, main, merged, p.bead);
        await noteMerge(main, { sha: merged, bead: p.bead, workspace: a.name, ref: p.ref, extra: ev.extra });
        const named = [...ev.ids, ...ev.controls];
        console.log(
          `[advocate] ${a.name}: ${p.bead} landed in ${merged.slice(0, 8)} — noted` +
            (named.length ? ` (${named.join(', ')})` : '')
        );
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
    // `a.name`, not `a.workspace` — the string `configuredBase` actually reads (see
    // test/wsshape.mjs's WANT_NAME/WANT_OBJECT audit; `a.workspace` is the {name, dir}
    // object and this file keeps the two apart on purpose). Computed once, outside the
    // loop, because it does not vary per checkout in a single tick and is what every
    // closed bead below is stamped with for the phone.
    const base = configuredBase(cfg, a.name);
    for (const repo of dirs) {
      let one;
      try {
        // `key` is which repo this checkout is, and it is only used to ask for the
        // conflict sweep a merge on github.com owes (rule 5 in lib/landed.js). Built
        // here rather than there because `repoDirs` above is what knows: it is the one
        // place that has already decided whether this workspace is one repo or forty.
        one = await reconcileLanded(bd, a.workspace, repo.dir, {
          base,
          key: repoKey(a.name, repo.name ? { name: repo.name } : null),
          // A pull request merged on github.com never passes the merge queue, so this is
          // the only door that can tell the window its branch landed. See lib/retitle.js.
          markMerged: (bead) => markWindowMerged(cfg, bead),
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
      // Stamped with the workspace and base here, once, rather than read back out of `a`
      // at the bottom of the function: lib/landed.js's own `closed` rows carry neither
      // (they are built from `bd`/GitHub fields, not from the advocate record that called
      // it), and `landedNewsEvents` below needs both to key and word the phone card.
      // `bead: c.id` is the same field under the name `landedEvent` reads it by — `id` is
      // kept too, unchanged, because the `emit(a, 'landed', …)` loop below this one (the
      // desktop console's own event, not the phone's) already reads it as `c.id`.
      result.closed.push(...(one.closed || []).map((c) => ({ ...c, workspace: a.name, base, bead: c.id })));
      result.skipped.push(...(one.skipped || []));
      result.cards.push(...(one.cards || []));
      // What the sweep did about *this Mac* — bc-6sqs, rule 4 in lib/landed.js. Said per
      // checkout and in landLocally's own words, because the interesting answers are the
      // refusals ("left main where it is — there is uncommitted work in beadcause:
      // lib/foo.js") and which checkout they are about is half of acting on
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
    // The phone, as opposed to `emit` two lines up: that one is this daemon's own
    // `advocate`/`landed` action, read by the desktop console; this is the fourth door
    // named in lib/mergesweep.js's header actually reaching the fourth kind of client.
    // The other three doors emit `landedEvent` themselves, next to the merge each one
    // performed (lib/server.js) — there is no equivalent moment here, because nothing in
    // this process performed the merge; the sweep only just found out. `landedNewsEvents`
    // is what decides whether that is one card per bead or a single summary card — see
    // bc-ka5y.15.7 and [LANDED_MANY_AT] in lib/news.js.
    for (const event of landedNewsEvents(result.closed, { quiet: mutedNews(cfg, a.name) })) {
      bus?.emit(event);
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
      // `cfg.workspaces` — the full list — so a marker naming a workspace other than
      // `a.workspace` can be resolved to read the original from its own tracker
      // (bc-xl7n.71). The writes about the duplicate itself still land on `a.workspace`.
      result = await sweepSuperseded(bd, a.workspace, { workspaces: cfg.workspaces });
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

  /* ---------------------------------------------------- cross-tracker blocks */

  /**
   * Clear a bead marked `blocked-by:` a bead in another tracker, once that far bead
   * closes — see lib/farblock.js, bc-bmry.7.
   *
   * Unlike `askSuperseded` this asks nobody: whether two beads are the same job is a
   * judgement, but whether the thing a bead was waiting on has closed is a fact, so the
   * marker just comes off and a comment says why. Run **before** the survey, unlike
   * `askSuperseded` and like `flagFinishedEpics`/`flagInMain` — clearing the marker is
   * exactly what lets `Bd.ready`'s row filter admit the bead again, so this *does* make a
   * difference to the queue built two lines down, where a superseded ask never does.
   *
   * Runs regardless of `paused`, for `askSuperseded`'s reason: pausing means "open no more
   * sessions", and this opens none — it is the one thing standing between a marked bead
   * and staying invisible forever even after the block it named is gone. `OBSERVING`
   * stops it, same as the sweep above: a spare-port instance has no business writing to
   * somebody else's tracker.
   */
  async function clearFarBlocked(a) {
    if (o.clearFarBlocked === false || OBSERVING) return;
    const due =
      minsSince(a.lastFarBlockedAt) >=
      clampInt(o.farBlockedIntervalMinutes, 1, 24 * 60, DEFAULTS.farBlockedIntervalMinutes);
    if (!due) return;

    a.lastFarBlockedAt = iso();
    let result;
    try {
      // `cfg.workspaces` — the full list — so a marker naming a workspace other than
      // `a.workspace` can be resolved to read the far bead from its own tracker. The
      // writes about the marked bead itself still land on `a.workspace`.
      result = await sweepFarBlocks(bd, a.workspace, { workspaces: cfg.workspaces });
    } catch (err) {
      // A sweep is a courtesy on top of the tick and may not take it down: whatever went
      // wrong, the advocate still has a queue to work.
      a.farBlocked = { summary: `far-block sweep failed: ${err.message.split('\n')[0]}`, cleared: 0, at: a.lastFarBlockedAt };
      console.error(`[advocate] ${a.name}: far-block sweep failed — ${err.message.split('\n')[0]}`);
      return;
    }

    const summary = describeFarBlocks(result);
    a.farBlocked = { summary, cleared: result.cleared.length, at: a.lastFarBlockedAt };
    // Every skip is worth a line, same as `askSuperseded`: a bead left held here is held
    // until the next sweep at least, and the reason belongs somewhere more durable than
    // a silent no-op.
    for (const s of result.skipped) console.log(`[advocate] ${a.name}: left ${s.id} blocked — ${s.why}`);
    if (!result.cleared.length) return;

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const c of result.cleared) {
      emit(a, 'farblock-cleared', {
        id: c.id,
        title: c.title,
        detail: `${c.target} closed — the cross-tracker block came off, and this is ordinary work again`,
      });
    }
  }

  /* --------------------------------------------------------- finished epics */

  /**
   * Put an epic whose children have all closed in front of Adam, before the survey below
   * ever sees it — lib/finishedepic.js.
   *
   * bc-xl7n.74. The failure this fixes is a worker window opened on an epic with no diff
   * left to deliver: `batchesFor` skips an epic with zero ready children, so it falls
   * through to ordinary dispatch, and a worker's only ending — `bin/deliver.js` — needs a
   * branch that a finished epic has none of. This sweep runs *before* the survey, like
   * `flagInMain` does and for the same reason: the `human` label it writes is what keeps
   * the epic out of the queue the survey is about to build two lines down, rather than
   * merely out of the *next* one.
   */
  async function flagFinishedEpics(a) {
    if (o.flagFinishedEpics === false || OBSERVING) return;
    const due =
      minsSince(a.lastFinishedEpicAt) >=
      clampInt(o.finishedEpicIntervalMinutes, 1, 24 * 60, DEFAULTS.finishedEpicIntervalMinutes);
    if (!due) return;

    a.lastFinishedEpicAt = iso();
    let result;
    try {
      result = await sweepFinishedEpics(bd, a.workspace);
    } catch (err) {
      // A sweep is a courtesy on top of the tick and may not take it down: whatever went
      // wrong, the advocate still has a queue to work.
      a.finishedEpic = { summary: `finished-epic sweep failed: ${err.message.split('\n')[0]}`, flagged: 0, at: a.lastFinishedEpicAt };
      console.error(`[advocate] ${a.name}: finished-epic sweep failed — ${err.message.split('\n')[0]}`);
      return;
    }

    /**
     * And the second question, over the same interval and the same switch — bc-jvt0.5.
     *
     * An epic the advocate decided to work *as itself* never reaches the sweep above: it
     * merges, `epicStaysOpen` leaves it open **and claimed** so no second worker is opened
     * on it, and `bd ready` — which is where that sweep gets its rows — is "open, unblocked,
     * nobody on it". So it sits there for ever with nothing asking. This half reads the
     * `whole-job` label instead, which is a list a claimed bead is still on, and asks git
     * whether the branch that epic owns is in `main`.
     *
     * Per checkout, for `flagInMain`'s reason and not as a stylistic echo of it: a branch is
     * in the `main` of the repo it was cut from and in nobody else's. A workspace with no
     * checkout mapped to it simply skips this half — the first question does not need one
     * and still runs.
     */
    const whole = { ok: false, reason: '', flagged: [], skipped: [] };
    const trouble = [];
    /**
     * **One tracker read for every checkout, rather than one each.** "Which epics did an
     * advocate decide were one job" is the same answer whichever repo is about to be asked
     * about them, and a workspace spanning forty repos (lib/repos.js) would otherwise pay
     * forty subprocesses per interval to hear it forty times. The beads one checkout
     * flagged come off the list before the next checkout sees it, which is what
     * `alreadyAsked` would have done for free had each pass re-read the tracker — the case
     * is hypothetical (a bead's branch lands in one repo, not two) and cheap to close.
     */
    let rows = [];
    let unread = '';
    try {
      rows = await bd.listLabel(a.workspace, WHOLE_LABEL);
    } catch (err) {
      unread = `could not read the whole-job epics — ${err.message.split('\n')[0]}`;
    }
    for (const repo of unread ? [] : repoDirs(a)) {
      let one;
      try {
        one = await sweepWholeEpics(bd, a.workspace, repo.dir, { rows, base: configuredBase(cfg, a.workspace) });
      } catch (err) {
        // A sweep is a courtesy on top of the tick and may not take it down, and one
        // checkout refusing is not the sweep failing.
        trouble.push(`${inWhich(repo)}${err.message.split('\n')[0]}`);
        continue;
      }
      if (!one.ok) {
        if (one.reason) trouble.push(`${inWhich(repo)}${one.reason}`);
        continue;
      }
      whole.ok = true;
      whole.flagged.push(...(one.flagged || []));
      whole.skipped.push(...(one.skipped || []));
      const done = new Set((one.flagged || []).map((f) => f.id));
      if (done.size) rows = rows.filter((r) => !done.has(r?.id));
    }
    // A workspace with no checkout mapped to it leaves `ok` false with nothing to say,
    // which `describeWholeEpics` renders as the empty string — the ordinary case, and not
    // the same thing as a tracker or a checkout that refused.
    if (!whole.ok) whole.reason = unread || trouble[0] || '';

    const summary = [describeFinishedEpics(result), describeWholeEpics(whole)].filter(Boolean).join('; ');
    a.finishedEpic = {
      summary,
      flagged: result.flagged.length + whole.flagged.length,
      at: a.lastFinishedEpicAt,
    };
    // Quiet skips — no children yet, still has an open one, a branch that has not landed —
    // are the ordinary state of almost every epic on almost every sweep, and logging them
    // every ten minutes would bury the rare one that could not be read at all.
    for (const s of [...result.skipped, ...whole.skipped]) {
      if (!s.quiet) console.log(`[advocate] ${a.name}: left ${s.id} alone — ${s.why}`);
    }
    for (const why of trouble) console.log(`[advocate] ${a.name}: whole-job epic sweep skipped — ${why}`);
    if (!result.flagged.length && !whole.flagged.length) return;

    console.log(`[advocate] ${a.name}: ${summary}`);
    for (const f of result.flagged) {
      emit(a, 'finishedepic', {
        id: f.id,
        title: f.title,
        detail: `all ${f.total} children closed — asked whether the epic is finished, rather than opening a session on it`,
      });
    }
    for (const f of whole.flagged) {
      emit(a, 'finishedepic', {
        id: f.id,
        title: f.title,
        // A different sentence from the one above, because it is a different finding: this
        // epic has no children to have closed, and what makes it finished is that the job it
        // was dispatched as has landed. A line reporting both as "all children closed" would
        // be the log describing a card it did not write.
        detail: `worked as one job, and ${f.branch} is already in ${f.base}${
          f.commit ? ` (${String(f.commit).slice(0, 8)})` : ''
        } — asked whether the epic can close, which its own merge deliberately did not do`,
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
        // `a.name`, not `a.workspace` — see the comment on the same call in `landed`
        // above; `configuredBase` reads a name string and `a.workspace` is the
        // `{name, dir}` object, which coerces to "[object Object]" and always misses
        // `pr.basePerWorkspace`. bc-ka5y.15.17.
        one = await sweepInMain(bd, a.workspace, repo.dir, { base: configuredBase(cfg, a.name) });
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
        // Two endings, because they are two different things to have done. On a leaf the
        // card asks whether the bead is finished; on an epic, or over a live descendant,
        // it says so and offers no close at all — bc-xl7n.52, and lib/inmain.js's
        // `closeOffer` is where the difference is decided. A line that reported both as
        // "asked whether it is finished" would be the log agreeing with the card it did
        // not write.
        detail: `${f.branch} is already in ${f.base}${f.commit ? ` (${String(f.commit).slice(0, 8)})` : ''} — ${
          f.close === false
            ? `said so on the bead and offered no close: ${f.why}`
            : 'asked whether it is finished'
        }, rather than opening a session on it`,
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
   *
   * **Two halves on one clock since bc-xl7n.63**, and the follow-up goes first. The
   * sweep's reading is taken at an instant and the card it files outlives it by days, so
   * `followNotInMain` re-asks about every card of this sweep's still in the inbox and
   * closes the ones the world has overtaken. It is on the same hourly clock rather than a
   * clock of its own for the reason that clock exists: both halves want a `gh pr list`
   * per branch, and the follow-up is looking at the cards this half filed.
   */
  async function flagNotInMain(a) {
    if (o.flagNotInMain === false || OBSERVING) return;
    const due =
      minsSince(a.lastNotInMainAt) >= clampInt(o.notInMainIntervalMinutes, 1, 24 * 60, DEFAULTS.notInMainIntervalMinutes);
    if (!due) return;

    const dirs = repoDirs(a);
    if (!dirs.length) return;

    a.lastNotInMainAt = iso();

    // The follow-up before the sweep, because it is the half that takes something *off*
    // the inbox and the sweep cannot undo its own reading — see lib/notinmain.js. One
    // `bd human list` for the whole thing rather than one per checkout: the cards are a
    // property of the workspace and every checkout would get the same list back. A
    // tracker that will not answer skips the follow-up and leaves the sweep to run,
    // which is the right way round — a correction not made is a card that stays another
    // hour, and a finding not filed is work nobody is told about at all.
    let cards = null;
    try {
      cards = await bd.listHuman(a.workspace);
    } catch (err) {
      console.error(`[advocate] ${a.name}: not-in-main follow-up skipped — could not read the inbox — ${err.message.split('\n')[0]}`);
    }
    if (cards) {
      for (const repo of dirs) {
        let f;
        try {
          // `a.name`, not `a.workspace` — see `flagInMain`'s call to `sweepInMain` above.
          // bc-ka5y.15.17.
          f = await followNotInMain(bd, a.workspace, repo.dir, { base: configuredBase(cfg, a.name), cards });
        } catch (err) {
          console.error(`[advocate] ${a.name}: not-in-main follow-up failed — ${inWhich(repo)}${err.message.split('\n')[0]}`);
          continue;
        }
        for (const s of f.skipped) {
          if (!s.quiet) console.log(`[advocate] ${a.name}: ${s.card} — ${s.why}`);
        }
        const line = describeFollowNotInMain(f);
        if (line) console.log(`[advocate] ${a.name}: ${line}`);
        if (!f.corrected.length) continue;
        // The cards it closed are gone from the list every later checkout would read, so
        // no second checkout re-asks GitHub about them or tries the close again.
        const gone = new Set(f.corrected.map((c) => c.card));
        cards = cards.filter((c) => !gone.has(String(c?.id || '')));
        for (const c of f.corrected) {
          emit(a, 'notinmain', {
            id: c.id,
            title: '',
            detail: `${c.card} said ${c.branch} never reached main and that has stopped being true — ${c.why}; closed it, and reopened nothing`,
          });
        }
      }
    }

    const result = { ok: false, reason: '', flagged: [], skipped: [], held: [], unasked: 0 };
    const threw = [];
    const quiet = [];
    for (const repo of dirs) {
      let one;
      try {
        // `a.name`, not `a.workspace` — see `flagInMain`'s call to `sweepInMain` above.
        // bc-ka5y.15.17.
        one = await sweepNotInMain(bd, a.workspace, repo.dir, { base: configuredBase(cfg, a.name) });
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
      result.held.push(...(one.held || []));
      result.unasked += one.unasked || 0;
    }
    if (threw.length && !result.ok) {
      a.notInMain = { summary: `not-in-main sweep failed: ${threw[0]}`, flagged: 0, at: a.lastNotInMainAt };
      console.error(`[advocate] ${a.name}: not-in-main sweep failed — ${threw[0]}`);
      return;
    }
    if (!result.ok) result.reason = quiet[0] || threw[0] || '';

    const summary = describeNotInMain(result);
    a.notInMain = { summary, flagged: result.flagged.length, held: result.held.length, unasked: result.unasked, at: a.lastNotInMainAt };
    // The loud skips only: a branch that landed, or has nothing on it, or has already
    // been asked about is the ordinary answer for nearly every branch on this laptop.
    // What is left is a git that could not answer and a tracker that refused a write —
    // and the second of those is a finding that may be filed twice, which is worth a line.
    for (const s of result.skipped) {
      if (!s.quiet) console.log(`[advocate] ${a.name}: ${s.id} — ${s.why}`);
    }
    if (!result.flagged.length && !result.unasked && !result.held.length) return;

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

  /**
   * Re-open the Epic Advocate on an epic something has moved under — the fourth door into an
   * unattended window, and the one nobody was standing in.
   *
   * lib/reenter.js is the argument, the enrolment rule and the three events; this is the
   * clock, the guards and the launch. What is here rather than there is everything that
   * needs the tick: the sessions snapshot, this advocate's own workers, the lease minutes,
   * and `persist`.
   *
   * **Below the three lines that stop the tick, deliberately.** This opens a window, so it
   * is doing rather than looking: an observer instance must not, a paused advocate means
   * "open no more sessions", and quiet hours mean it too. It sits *above* the queue work
   * because it is not queue work — an Epic Advocate takes no worker slot, competes for none,
   * and is the one window that must still be openable on a repo already at its limit,
   * since a repo at its limit is exactly when supervision is worth something. What bounds
   * it instead is stated in three places and enforced here: one window per tick per
   * workspace, one per epic per `reenterCooldownMinutes`, and never one where a session
   * already names the bead.
   *
   * **A skipped event keeps the old snapshot.** The single subtlety in here, and the bug it
   * avoids is silent: `reentryFor` hands back the snapshot as it is *now*, so storing that
   * while declining to open the window would consume the event — the child would be
   * recorded as already-seen-closed and no window would ever be opened for it. So every
   * `keep[...] = prev` below is an event deliberately left undelivered until the next
   * sweep, and an `at` stamped beside one is a back-off rather than a launch.
   */
  async function reenter(a) {
    if (o.reenterAdvocates === false) return;
    const every = clampInt(o.reenterIntervalMinutes, 1, 24 * 60, REENTER_DEFAULTS.reenterIntervalMinutes);
    if (minsSince(a.lastReenterAt) < every) return;
    a.lastReenterAt = iso();

    let index;
    try {
      index = await bd.graph(a.workspace);
    } catch {
      return;
    }
    // A graph that would not answer must not be read as "nothing is enrolled". `Bd.graph`
    // swallows its own failures and hands back an empty index that says `error`; taking
    // that at face value would prune every snapshot, and the *next* successful sweep would
    // then read a whole subtree as newly filed. Returning leaves the records alone, which
    // is the direction where nothing happens rather than the direction where a window does.
    if (index?.error || !index?.beads?.size) return;

    const stallMinutes = clampInt(o.reenterStallMinutes, 1, 7 * 24 * 60, REENTER_DEFAULTS.reenterStallMinutes);
    const cooldown = clampInt(o.reenterCooldownMinutes, 1, 7 * 24 * 60, REENTER_DEFAULTS.reenterCooldownMinutes);
    const sessions = a.liveSessions || [];
    /**
     * Is anybody on this child? All three answers a stall has to survive, and none of them
     * is a timestamp: a worker this advocate is holding (`workerHolds` — its batch and
     * its plan group included, because both are windows briefed on beads that are not
     * their own `id`), a live Claude Code session naming the bead — which covers a window
     * Adam opened by hand — and a live lease from another Mac, which is the only one of
     * the three that can see off this laptop.
     */
    const busy = (row) =>
      workerHolds(a.workers, row.id) ||
      sessions.some((s) => namesBead(s?.name, row.id)) ||
      leasesOf(row.labels).some((l) => isLive(l, leaseOpts()));
    /**
     * And the ending the tracker cannot tell from a stall: a bead parked behind a delivery
     * card or a merge-bead nobody has answered yet. Built once here rather than per row —
     * it is a pass over `index.edges`, which the sweep already has in its hand, and no
     * further read of anything. The handback half needs nothing at all; `reentryFor` reads
     * the `human` label off the row. See lib/reenter.js, which argues for both.
     */
    const delivered = waitingOnMerge(index);
    // Same walk, the id rather than the bare boolean — for `epicAdvocatePrompt`'s child
    // list (bc-xl7n.99), which names what a delivered child is waiting on rather than only
    // flagging that it is. Free: `waitingOnMergeCard` reads nothing `delivered` did not.
    const deliveryCard = waitingOnMergeCard(index);

    const held = (a.reenterHeld ||= new Set());
    const keep = {};
    let opened = 0;
    for (const { epic, kids, tree } of advocatedRoots(index)) {
      const prev = a.advocated?.[epic.id] || null;
      const { reason, record } = reentryFor(prev, tree, { busy, delivered, stallMinutes });
      if (!reason) {
        keep[epic.id] = record;
        held.delete(epic.id);
        continue;
      }

      const mins = minsSince(record.at);
      const live = advocateSession(sessions, epic.id, { openedAt: openedRecently(`${a.name}/${epic.id}`) });
      const why = isPaused(epic)
        ? // First of the five, because it is the only one that is somebody's decision
          // rather than a state of the machine — and because `keep[epic.id] = prev` below
          // is what makes a pause lossless: the events that happened while it was paused
          // stay in the snapshot, so the window opened after the resume is briefed on all
          // of them at once rather than on a graph that has quietly caught up. Dropping
          // the record instead would make the resume a *first sight*, which is silent by
          // design, and an epic that came back saying nothing had moved would be the worst
          // possible reading of a fortnight's work.
          'it is paused'
        : opened
          ? "another epic already took this tick's window"
          : mins < cooldown
            ? `its last one was ${Math.round(mins)}m ago and the floor is ${cooldown}m`
            : live
              ? `a session already names it${live.pid ? ` (pid ${live.pid})` : ' and is still coming up'}`
              // And the epic itself put through the same three questions its children are: a
              // worker or planner window this advocate is holding *on the epic* is one
              // `advocateSession` cannot see until it has named itself, and a live lease on
              // it is another Mac's window, which nothing on this laptop can see at all.
              : busy(epic)
                ? 'a window this advocate opened, or another Mac, is already holding it'
                : null;
      if (why) {
        // The hold rides the record the board card reads (`advocacyOn`, lib/epicadvocate.js).
        // Three of these five reasons are things only a tick can see — its own one-window
        // budget, a worker this advocate is holding, a lease on another Mac — so a card
        // that tried to re-derive the sentence would be a second answer to one question,
        // and the two would disagree on exactly the epics somebody is looking at. Stamped
        // with `at`, because a reason persisted across a restart is a reason that may have
        // lapsed and a card has to be able to say how old it is.
        keep[epic.id] = { ...(prev || record), hold: { why, at: iso() } };
        // Once per epic per spell of being held, like every other filter here: this runs
        // every ten minutes and a cooldown lasts three hours, so a line per sweep would be
        // eighteen of them saying the same thing about an epic nothing is wrong with.
        if (!held.has(epic.id)) {
          held.add(epic.id);
          console.log(`[advocate] ${a.name}: holding an Epic Advocate on ${epic.id} — ${why} (${reason})`);
        }
        continue;
      }
      held.delete(epic.id);

      // Read for the one epic about to get a window rather than for every enrolled one: this
      // is a `bd comments` spawn, where everything above it came out of one cached export.
      const plan = await readPlan(bd, a.workspace, epic.id).catch(() => null);
      try {
        await openAdvocate(cfg, a.workspace, epic, {
          kids,
          // bc-khoe.33. `advocatedRoots` hands back both lists off one index and until now
          // only the first was used here: `kids` is one level, and a plan reaches the whole
          // subtree, so an advocate shown only children was revising a plan over half of what
          // it has to cover. Free — the walk already happened.
          tree,
          plan: plan ? formatPlan(plan) : null,
          // The whole point of the sentence lib/reenter.js builds: the brief says "You were
          // opened because …", and a re-entry that could not say what moved would hand a
          // supervisor the same window it got last time and no reason to look anywhere new.
          reason,
          bd,
          // bc-xl7n.99: which of `kids` is delivered, off the same index this tick already
          // built `delivered` from. The button door (`POST /api/bead/advocate`) has no index
          // to build this from without a fresh `bd.graph` call, so it is left undefined there
          // and the child list falls back to no annotation — the safe direction, and not a
          // new call this bead's acceptance forbids.
          deliveryCard,
        });
      } catch (err) {
        const detail = err.message.split('\n')[0];
        // The event survives and the cooldown starts anyway. A refusal here is one of the
        // states `openEpicAdvocateSession` refuses and the button refuses with it —
        // unendorsed, superseded, a ship bead — or iTerm saying no, and re-arguing any of
        // them every ten minutes is noise. Three hours later it tries once more, with the
        // event intact.
        keep[epic.id] = { ...(prev || record), at: iso(), hold: { why: `the launch was refused — ${detail}`, at: iso() } };
        console.warn(`[advocate] ${a.name}: could not re-open the Epic Advocate on ${epic.id} — ${detail}`);
        emit(a, 'failed', { id: epic.id, detail });
        continue;
      }
      record.at = iso();
      keep[epic.id] = record;
      // The assignment, recorded at the launch and on the bead — bc-r2b5.1, and the same
      // write `POST /api/bead/advocate` makes at its own door. Most epics reaching here
      // already carry it, so this is a `bd` spawn only on the one that was enrolled by its
      // waiting-on sentence alone: it upgrades that epic to the carrier that survives a
      // window dying, which is the whole point of the label.
      //
      // **A failure here is not a failure to open the window**, which is already up. The
      // honest report is a warning naming the epic that is running unassigned, not an
      // exception that loses the launch and re-argues it in ten minutes.
      if (!isAssigned(epic)) {
        try {
          await bd.addLabel(a.workspace, epic.id, ADVOCATE_LABEL);
        } catch (err) {
          const why = err?.message ? err.message.split('\n')[0] : String(err);
          console.warn(`[advocate] ${a.name}: opened an Epic Advocate on ${epic.id} but could not record the assignment — ${why}`);
        }
      }
      // The same record the button writes, in the same place, so the card says "an advocate
      // is opening" for a window this opened too. See lib/epicadvocate.js.
      rememberAdvocateOpened(`${a.name}/${epic.id}`);
      opened += 1;
      console.log(`[advocate] ${a.name}: re-opened the Epic Advocate on ${epic.id} — ${reason}`);
      emit(a, 'advocated', { id: epic.id, why: reason });
    }
    // Assigned rather than merged, which prunes the record of an epic that is no longer
    // enrolled — its advocate took its waiting-on sentence off, or somebody closed it. An
    // epic that comes back is a first sight again, which is silent, and that is the right
    // answer: the movement while nothing was advocating it is not news anybody asked for.
    a.advocated = keep;
    persist();
  }

  async function tickOne(a, sessions) {
    a.error = null;
    // A fresh export per tick, shared by everything in this tick that wants one — see
    // `tickGraph`. `undefined` rather than `null`, because those mean different things.
    a.tickGraph = undefined;
    // And the two lists `candidates` writes, emptied here rather than there — because
    // `candidates` is the one filter in this file that a tick can return without ever
    // reaching. Every `heldBy*` above is cleared inside `survey`, which runs before the
    // three lines that stop a paused, quiet or maintenance tick; these are computed after
    // them, so a paused advocate would otherwise keep drawing whichever department was busy
    // when it was last dispatching. Nothing was held on a tick that picked nothing, and an
    // empty list is what says so. What was already *said* is remembered separately below,
    // so emptying these cannot turn one hold into a log line every thirty seconds.
    a.heldByDept = [];
    a.relayProblems = [];
    a.quiet = o.respectQuietHours && isWorkspaceQuiet(cfg, a.name);

    const mine = sessions.filter((s) => s.workspace === a.name);
    await reconcile(a, mine);
    // After the reconcile, so a window this advocate is still holding is claimed by the
    // worker that owns it rather than swept out from under it.
    await sweepWindows(a, mine);
    // And after that one, because it reads the same two lists both of them write: a
    // window with a worker on it, or on its way to being closed, is not a window this
    // has anything to say about. Runs while `paused` for the same reason the sweeps do —
    // pausing means "open no more sessions", and a window somebody opened by hand during
    // a pause is exactly the kind this exists for. See `leaseHandOpened` and bc-3p53.
    await leaseHandOpened(a, mine);
    // And the third sweep, after both of those and before `reapClosing`, which is what
    // acts on what all three of them put on the closing list. Last of the three because
    // it is the widest and the least certain: a window `reconcile` has an ending for, or
    // `sweepWindows` can prove is finished, should be closed with that reason on it
    // rather than as "it went quiet". See `parkIdle`.
    parkIdle(a, mine);
    // After all three, which are what put things on the closing list, and before the
    // worktree sweep, which is happier once the window it wants to retire has gone.
    reapClosing(a, mine);
    // Its own queue, its own guards, and no `sessions` to match against — see the note
    // above it. Ordered after `reapClosing` only because both are closers and this is
    // the newer one; neither can put anything on the other's list.
    await reapNeverStarted(a);
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
    // Also before the survey, and here it *does* make a difference to it: clearing a
    // `blocked-by:` marker is exactly what lets `Bd.ready`'s row filter admit the bead
    // again, so a block that closed since the last sweep can go straight from cleared to
    // queued in the same tick. See lib/farblock.js and bc-bmry.7.
    await clearFarBlocked(a);
    // Also before the survey, and here it *does* make a difference to it, same as
    // `flagInMain` two lines down: the `human` label this writes is what keeps an epic
    // whose children have all closed out of the queue built two lines below. See
    // `flagFinishedEpics` and bc-xl7n.74.
    await flagFinishedEpics(a);
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
    // And which epics are paused, before the survey rather than with the roster below,
    // because `withoutPausedEpics` runs *inside* it. Rebuilt from the graph here and read
    // again by `rosterFor` after the launch: the roster is a display and can afford to be
    // a tick behind, the queue cannot — a first tick after a restart that surveyed with an
    // empty pause set would dispatch under every paused epic in the workspace exactly once,
    // which is the one moment a pause has to hold and the one it would have missed.
    await refreshPauses(a);

    // Switched off from the console, and still holding windows it opened — see `disable`.
    // Every sweep above this line has run, which is the drain: the sessions it started
    // are still reaped, archived and asked to check in by the advocate that started
    // them. Everything below it is looking for more work, which is exactly what the
    // switch said to stop doing — including the survey, because a `bd ready` per repo
    // per thirty seconds for a repo you turned off is traffic nobody asked for.
    if (a.draining) {
      a.queue = [];
      const open = a.workers.length + a.closing.length + a.closingWindows.length;
      if (!open) {
        advocates.delete(a.name);
        console.log(`[advocate] ${a.name}: switched off — its last session has finished`);
        return;
      }
      return note(a, `switched off · ${open} session(s) still running`);
    }

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
    // The nightly window, and it stops every advocate at once — see `driveMaintenance`.
    // Above `paused` and `quiet` because it is the only one of the three that is neither
    // a setting nor a clock somebody chose per space: those two say "this repo is off
    // tonight", and this one says "nothing anywhere is launching for the next half hour",
    // which is the sentence a person looking at a still board actually needs. It is also
    // the only one of the three that is *about to end on its own*, so it is worth saying
    // which phase it is in rather than leaving four gates reading identically.
    if (holdsDispatch(maintenance)) {
      return note(a, `${describeMaintenance(maintenance)} · ${a.queue.length} ready`);
    }
    if (a.paused) return note(a, `paused · ${a.queue.length} ready`);
    if (a.quiet) {
      const until = quietUntil(spaceFor(cfg, a.name));
      return note(a, `quiet${until ? ` until ${until.toISOString().slice(11, 16)}` : ''} — watching, not launching`);
    }

    // The fourth door into an unattended window, and it is not queue work: an Epic Advocate
    // takes no worker slot and competes for none, so it runs before every number below and
    // is unaffected by all of them. Below the three returns above it because it opens a
    // window — see `reenter`, which owns why each of those three stops it.
    await reenter(a);

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

    // Rebuilt before the budgets are read, so the card and the launch agree about how
    // many EpicAdvocates there are within one tick rather than one tick apart.
    a.epicAdvocates = await rosterFor(a);

    // Two budgets, counted against two populations, and neither subtracts from the other.
    // `free` is coding windows against this repo's `maxWorkers`; `epicFree` is planning
    // windows against its `maxEpicAdvocates`. Before this, a planner came out of `free`,
    // so planning an epic cost a coding window and the two competed — on a busy repo the
    // cheap, fast one lost, which is the opposite of what you want from the thing that
    // decides what the expensive ones do.
    const free = a.limit - codersOf(a).length;
    const unattended = await unattendedWorkers();
    // Four terms, from three beads, and the order of the last two is load-bearing:
    // test/windowbudget.mjs anchors on `totalResolvers() - reservedForResolvers()` as one
    // string, because a reservation that stops being subtracted here is a change nothing
    // else in this file would show. Put a new term on the end, not in the middle.
    const globalFree =
      globalLimit() - totalWorkers() - totalResolvers() - reservedForResolvers() - unattended;
    const epicFree = (a.epicLimit ?? DEFAULTS.maxEpicAdvocates) - plannersOf(a).length;
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
    // `heldBySurface` is deliberately not among these, and it is the only hold list that is
    // not. Every reason here can empty the queue, which is what this block exists to
    // explain; a same-tick surface collision never can, because the *winner* is always kept
    // — so a tick with one is a tick that is opening a window, and its sentence goes on the
    // line that says so. See `withoutCollidingSiblings` and `deferredNote` below.
    // And the seventh, which is the only one of them that no window closing and no merge
    // will ever clear: a queue emptied because nothing on the board has decided any of it.
    // It counts into `quiet` like the rest, and here that matters more than anywhere else
    // — the alternative is an advocate that refuses every bead in the tracker and then
    // proposes new ones beside them. See `withoutOrphans` and lib/underroot.js.
    const orphaned = (a.heldByNoRoot || []).length;
    // And the eighth, which is the only one of them somebody chose: a queue emptied
    // because every bead left in it is under an epic that has been paused. It counts into
    // `quiet` like the rest and for the sharpest version of the same reason — an advocate
    // that reported "clear" over a paused epic and then *proposed new work* would be
    // filing beads into a subtree somebody had just pressed stop on.
    const held0 = (a.heldByPause || []).length;
    // And the ninth, bc-jvt0.4, which is the only one waiting on a *judgement* rather than
    // on a window, a branch, a file or a person's button: an owned childless epic nothing
    // has decided about yet. It counts into `quiet` like the rest, and for the reason this
    // whole block exists — an advocate that said "clear" over one and then proposed new
    // work would be proposing beside an epic somebody had already agreed to, whose only
    // problem is that nobody has said what it decomposes into.
    const undecided = (a.heldByUndecided || []).length;
    // And the newest, bc-4r10.20: a bead whose merge-bead already closed, so `bd ready`
    // hands it back while lib/owed.js is still retrying the close it landed with. It
    // counts into `quiet` for the same reason `heldByNoRoot` does — an advocate that said
    // "clear" over it and then proposed new work would be filing beads beside one already
    // finished. Ordinarily gone within a poll or two; see `withoutOwed`.
    const owedRetry = (a.heldByOwed || []).length;
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
      const orphanNote = orphaned ? ` · ${orphaned} with nothing decided above ${orphaned === 1 ? 'it' : 'them'}` : '';
      const pauseNote = held0 ? ` · ${held0} under a paused epic` : '';
      const undecidedNote = undecided
        ? ` · ${undecided} childless epic${undecided === 1 ? '' : 's'} nobody has decided the shape of`
        : '';
      const owedNote = owedRetry ? ` · ${owedRetry} already merged and waiting for the close to retry` : '';
      const quiet =
        held ||
        twins ||
        inflightHeld ||
        sitting ||
        claimed ||
        unplaceable ||
        onBusyFiles ||
        orphaned ||
        held0 ||
        undecided ||
        owedRetry;
      // And the retired ones, which until bc-xl7n.117 could not reach this branch at all:
      // every bead `givenUp` knew about was *in* the queue, so an empty queue meant an
      // empty list by construction. A claimed one is in neither, which is exactly the
      // shape of a repo whose only outstanding work is a delivered pull request nobody
      // can re-open a window on — the one tick where saying nothing is worst.
      const holdNotes = `${repoNoteText}${heldNote}${undecidedNote}${twinNoteText}${prNoteText}${liveNote}${leaseNote}${claimNote}${orphanNote}${pauseNote}${owedNote}${gaveUpNote(a)}`;
      note(
        a,
        a.workers.length
          ? `${a.workers.length} session(s) working, nothing else ready${holdNotes}`
          : `${quiet ? 'nothing ready' : 'clear — no ready beads'}${holdNotes}`
      );
      if (!a.workers.length && !quiet && o.propose) await propose(a);
      return;
    }
    if (free <= 0) return note(a, `${a.queue.length} ready · at its limit of ${a.limit} session(s)${gaveUpNote(a)}`);
    // `globalLimit()` and not `o.globalMaxWorkers`: the raw value is what the config
    // asked for and the clamped one is what `globalFree` was computed from, so quoting
    // the raw one would name a cap that is not the cap holding this repo up.
    //
    // And the resolvers are said out loud when there are any, for the same reason the
    // note names the cap at all: "held by globalMaxWorkers (20)" over eighteen live
    // sessions reads as arithmetic that does not add up, and whoever goes looking for
    // the missing two will not find them in any advocate's card — they are on the pull
    // request board. See `totalResolvers`.
    //
    // And the ones this daemon does not have a row for at all (bc-2uj4.13): those are
    // not on the pull request board either, and not on any advocate's card until this
    // line — "at its limit of 2" over a laptop nobody can find two live sessions on is
    // the exact arithmetic bc-7qo.19 caught this file printing. See `unattendedWorkers`.
    if (globalFree <= 0) {
      const resolving = totalResolvers();
      const resolverNote = resolving
        ? ` · ${resolving} of them ${resolving === 1 ? 'is a session resolving a pull request' : 'are sessions resolving pull requests'}`
        : '';
      // And the reservation, for the same reason the resolvers are named: a card that says
      // "held by globalMaxWorkers (4)" over three live windows is arithmetic nobody can
      // check, and the fourth is not a window at all — it is a slot being kept empty for a
      // queue on the pull request board. Unsaid, this reads as the count being wrong.
      // See `reservedForResolvers`.
      const inLine = reservedForResolvers() ? inLineForWindow() : 0;
      const queueNote = inLine
        ? ` · 1 more is being kept for the ${inLine} pull request${inLine === 1 ? '' : 's'} in line for a window`
        : '';

      const unattendedNote = unattended
        ? ` · ${unattended} more ${unattended === 1 ? 'window is' : 'windows are'} open that this daemon has no record of`
        : '';
      // Order: the two that are live windows first, then the one that is not a window at
      // all. A reader counting sessions against the cap can stop as soon as the numbers
      // add up, and the reservation is the term that will not be found on the Mac.
      return note(
        a,
        `${a.queue.length} ready · held by globalMaxWorkers (${globalLimit()})${resolverNote}${unattendedNote}${queueNote}${gaveUpNote(a)}`
      );
    }
    if (!ready.length) {
      // Split, because the number this used to print was the whole defect: `settling`
      // was `queue - ready`, which welded a bead thirty seconds old to a bead that will
      // wait for ever, reported them as one figure and named neither. What is left in it
      // now is only what really does clear itself — a bead inside `settleSeconds`, or one
      // this advocate already has a window open on. See `givenUp`.
      // `queue − ready − retired`, and **the retired ones that are in the queue** — the
      // claimed half `givenUp` gained in bc-xl7n.117 is not in `a.queue` at all, so
      // subtracting it here would take a genuinely settling bead off a count of the queue
      // it was never in, and can drive the number negative. The pill beside this counts
      // both; this subtraction is arithmetic about one list.
      // And the department holds are subtracted for exactly the reason the retired ones
      // are (bc-ogicx.6): they are beads in `a.queue` that `candidates` took out, so a
      // count of `queue − ready` would report a bead waiting on a `capacity:` as one that
      // is thirty seconds old and about to be picked up. Their own sentence is on the same
      // line, so the two numbers add up in front of the reader rather than one absorbing
      // the other. No overlap to double-subtract: the capacity filter runs *after* the
      // attempt filter, so a bead at the cap never reaches it.
      const gone = givenUp(a).filter((g) => !g.claimed);
      const settling = a.queue.length - ready.length - gone.length - (a.heldByDept || []).length;
      const settlingNote = settling ? ` · ${settling} settling or already under way` : '';
      return note(a, `${a.queue.length} ready${settlingNote}${deptNote(a)}${relayNote(a)}${gaveUpNote(a)}`);
    }
    if (secsSince(a.lastLaunchAt) < clampInt(o.launchCooldownSeconds, 0, 3600, DEFAULTS.launchCooldownSeconds)) {
      return note(a, `${ready.length} to pick up · cooling down since the last launch${gaveUpNote(a)}`);
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
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on${deptNote(a)}${relayNote(a)}${gaveUpNote(a)}`);
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
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on${deptNote(a)}${relayNote(a)}${gaveUpNote(a)}`);
    }

    // And the third, the cheapest and the last thing between a bead and a window: is
    // somebody already sitting in it. A file read rather than a `gh` call, so it is
    // unconditional without needing an interval to be excused from. See `resight`.
    if (await resight(a, ready)) {
      try {
        a.queue = await survey(a);
      } catch (err) {
        a.error = err.message.split('\n')[0];
        note(a, `cannot read the tracker — ${a.error}`, 'warn');
        return;
      }
      ready = candidates(a);
      if (!ready.length) return note(a, `${a.queue.length} ready · nothing to open a session on${deptNote(a)}${relayNote(a)}${gaveUpNote(a)}`);
    }

    // Split by brief, then rationed separately. `bead.planner` is what `launch` already
    // reads to decide which of the two briefs a window gets, so it is what decides which
    // budget the window comes out of — one field, one meaning, in both places.
    const wantsPlan = (b) => Array.isArray(b.planner);
    const readyPlans = ready.filter(wantsPlan);
    const readyWork = ready.filter((b) => !wantsPlan(b));

    const planSlots = Math.max(0, Math.min(epicFree, readyPlans.length));
    const workSlots = Math.max(0, Math.min(free, globalFree, readyWork.length));
    const slots = planSlots + workSlots;
    // The one hold that has to be said on *this* line rather than on the quiet one below,
    // and it is the only one of the nine that does. Every other hold can empty the queue,
    // so its sentence belongs where an empty queue is explained; this one never can — the
    // winner of a collision is always kept, so a tick with a deferral is by construction a
    // tick that is opening something. Said here, or it is a bead that quietly does not open
    // beside one that does, which is the state the whole card exists to prevent.
    const deferredNote = (a.heldBySurface || []).length
      ? ` · ${a.heldBySurface.length} deferred a tick behind the same files`
      : '';
    note(
      a,
      `${a.queue.length} ready · opening ${slots} session(s)${
        planSlots ? ` (${planSlots} planning, outside the ${a.limit}-session worker limit)` : ''
      }${deferredNote}${deptNote(a)}${relayNote(a)}${gaveUpNote(a)}`
    );
    // Planners first. They are the cheap half, they finish in minutes, and every one of
    // them decides what a later coding window is briefed on — so a tick that can afford
    // only some of what it wants should spend it on the judgement rather than the labour.
    for (const bead of [...readyPlans.slice(0, planSlots), ...readyWork.slice(0, workSlots)]) {
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
        /**
         * A window is already on it — bc-7qo.19, and it is the same shape as the line
         * above rather than the two below. No attempt is charged, because nothing about
         * the *bead* failed; and the loop carries on, because unlike iTerm refusing this
         * says nothing at all about the next bead in the list.
         *
         * Reaching here means `withoutLiveSessions` did not hold — the filter is
         * switchable and the queue is not the only route in — so the line is worth
         * printing rather than swallowing: a door refusal that fires every tick is a
         * filter that has stopped working, and the pids in the message are how anyone
         * finds out which windows those are (`ps -p <pid> -o args -ww`).
         */
        if (err.occupied) {
          note(a, `${bead.id} — ${err.message.replace(/^.*may not be worked — /, '')}; no second session opened`, 'warn');
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
  /**
   * Drive the nightly window one step. Called once per tick, above the advocate loop.
   *
   * lib/maintenance.js decides; this does. The split is what makes a state machine whose
   * transitions are "forty-five minutes later" and "the next night" testable at all — and
   * it is why every number in the sequence lives over there and none of them here.
   *
   * **One limitation, stated rather than hidden:** `tick` returns early when no workspace
   * has an advocate at all, so an install that advocates nothing never reaches this and
   * never collects. That follows from the window living in the advocate — which is where it
   * was asked for — and it is the right place for the drain, which is only about windows an
   * advocate opened. If a watch-only install ever needs collecting, this moves to the
   * daemon's own cycle in lib/server.js and the drain stays here.
   *
   * **What `live` counts, and what it deliberately does not.** Every window this daemon
   * opened and still holds: workers, planners and the ones already on their way out. Not
   * `sessions`, which is every live Claude Code session on the Mac — because windows
   * somebody opened by hand are explicitly not this daemon's to close, and counting them
   * would make "the Mac is empty" a condition a hand-opened terminal could hold open all
   * night. `reclaim` makes the same distinction and says so at more length.
   */
  async function driveMaintenance(order, sessions) {
    const live = order.reduce((n, a) => n + a.workers.length + a.closing.length, 0);
    const v = decideMaintenance(maintenance, { o, now: new Date(), live });
    const moved = v.phase !== maintenance.phase;
    maintenance = { phase: v.phase, night: v.night, why: v.why };
    // One line per transition, not per tick: a window sitting in `draining` for forty
    // minutes has nothing new to say, and saying it every thirty seconds would bury the
    // four lines that matter.
    if (moved && v.phase !== 'idle' && v.phase !== 'off') console.log(`[maintenance] ${describeMaintenance(v)}`);

    if (v.act === 'ask') {
      /**
       * **Not `reclaim`, and the difference is the whole value of the drain.**
       *
       * Reusing the Reclaim button was the first version of this and it was wrong twice
       * over. Its message (`checkinMessage`) tells a session that is still working to
       * *carry straight on* — so forty-five minutes of grace would be spent advancing the
       * work rather than landing it, and then the window is signalled mid-thought, which
       * is the exact outcome the grace period exists to prevent. And its bookkeeping means
       * "the daemon wants this slot back": it stamps `w.asked`, so a worker that does not
       * answer inside `checkinMinutes` loses its slot to the next launch — a second,
       * shorter, differently-argued deadline running underneath this one.
       *
       * So the notice is `maintenanceMessage`, which names the deadline and asks for a
       * debrief, and nothing here touches the slot list. What is borrowed from `reclaim` is
       * the half that was right: `parkIdle` at `idleMinutes: 0`, which writes down and
       * closes the windows that are *already* quiet, so the drain only ever waits on
       * windows genuinely mid-turn.
       */
      let told = 0;
      let unreachable = 0;
      for (const a of order) {
        a.liveSessions = sessions;
        for (const w of a.workers) {
          if (!w.term) {
            unreachable += 1;
            continue;
          }
          try {
            const answer = await say(w.term, maintenanceMessage(w.id, v.dueIn ?? 0, { title: w.title }));
            if (answer === 'missing') unreachable += 1;
            else told += 1;
          } catch (err) {
            console.error(`[maintenance] ${a.name}: could not reach ${w.id}'s window — ${err.message}`);
            unreachable += 1;
          }
        }
        // The ones already quiet go now, written down first, rather than being waited on
        // for forty-five minutes and then signalled. `parkIdle` is the same call the
        // Reclaim button makes, and `idleMinutes: 0` is the same argument: the window
        // having started *is* the judgement the grace period otherwise has to infer.
        parkIdle(a, sessions.filter((s) => s.workspace === a.name), { idleMinutes: 0 });
      }
      console.log(
        `[maintenance] told ${told} window(s) they have ${v.dueIn ?? 0}m` +
          (unreachable ? `; ${unreachable} could not be reached` : '')
      );
      return;
    }

    if (v.act === 'force') {
      // `stood-down` rather than a signal of our own, and the reuse is the safety
      // property: `finish` parks the conversation *before* anything is closed, and then
      // hands the row to lib/reap.js, which SIGTERMs, waits out `closeHardSeconds` and
      // SIGKILLs. `reapClosing` runs later in this same tick and reads
      // `maintenanceForcing()`, which is how the two guards get waived for exactly these
      // rows and nothing else.
      let forced = 0;
      for (const a of order) {
        for (const w of a.workers) {
          /**
           * **And it costs the bead an attempt** — bc-7qo.19.
           *
           * This is the one `finish` in the file that used to charge nothing while
           * ending a window that produced nothing. Every other no-progress ending does
           * (`ended`, `timeout`, `lapsed`), and the two that deliberately do not —
           * `delivered` and `handback` — are endings the session *reached*. A window
           * closed here reached none: it is torn out mid-turn, its worktree is archived
           * with 0 commits, and nothing about the bead is any further forward.
           *
           * Left uncharged, `maxAttemptsPerBead` cannot bite on the one loop where it
           * is needed most. On 2026-08-21 bc-7qo.11 was opened and stood down 28 times
           * in six hours and 27 of those 28 launches logged `attempt 1`, because the
           * counter only ever moved on the paths above. The cap is the backstop for a
           * bead that keeps costing windows and delivering nothing, and this is exactly
           * that shape.
           *
           * Charging it is recoverable and *visible*: a bead at the cap is named on the
           * console by `givenUp`, with how many charges it carries, and `rearm` (the
           * card's own button) clears them. That is the difference between this and
           * `standDown`, four hundred lines up, which drops the charges instead —
           * losing a race to another Mac is evidence about the race, not about the bead.
           */
          a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
          finish(a, w, 'the nightly maintenance window is closing the Mac down', 'stood-down');
          forced += 1;
        }
        // `finish` does not take the worker off the slot list — every other caller is a
        // filter loop that rebuilds the array, and this one has to do the same. Leaving it
        // was a real bug and a quiet one: the row stayed a live worker forever, so `live`
        // never reached zero, the night never collected before the reserve, and the slot
        // was held against `maxWorkers` by a window that had already been signalled.
        a.workers = [];
      }
      if (forced) console.log(`[maintenance] stood ${forced} window(s) down`);
      return;
    }

    if (v.act === 'collect') {
      // The phase is written down *and persisted* before the collection starts, so a
      // daemon that dies mid-gc comes back knowing one was running. `decide` answers
      // `none` to a persisted `collecting`, which means such a night waits out its bound
      // and then resumes rather than starting a second collection behind the first one's
      // gate lock. Costing a night's collection is the right side of that trade.
      persist();
      /**
       * **Every configured workspace, not just the advocated ones.**
       *
       * The drain is about advocates, because they are what has windows open. The
       * collection is not: the inbox sweeps *every* workspace in `cfg.workspaces` on every
       * poll, so every one of their stores bloats and every one of them is on the path of
       * a phone read. Collecting only the advocated subset would leave the workspaces you
       * merely *watch* — which on this Mac is most of them — exactly as slow as before,
       * and the symptom would be a maintenance window that measurably did nothing.
       *
       * Nothing to drain in an unadvocated workspace, so there is no safety question here
       * that the advocated ones have not already answered.
       */
      const workspaces = cfg.workspaces?.length ? cfg.workspaces : order.map((a) => a.workspace);
      const results = await collectStores(bd, workspaces, { shared: o.maintenanceCollectShared === true });
      for (const r of results) {
        if (r.ok) console.log(`[maintenance] ${r.workspace}: ${r.detail}`);
        else console.error(`[maintenance] ${r.workspace}: collection failed — ${r.detail}`);
      }
      const failed = results.filter((r) => !r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      const did = results.length - failed - skipped;
      // Every number in the sentence, and the skips loudest of all: a window that reports
      // "collected 9 workspaces" over a tenth it deliberately left alone is a window that
      // reads as complete coverage, and the one it left is the shared team tracker.
      maintenance = {
        phase: 'done',
        night: v.night,
        why: [
          `collected ${did} of ${results.length} workspace(s)`,
          skipped ? `${skipped} skipped as shared` : '',
          failed ? `${failed} failed` : '',
        ]
          .filter(Boolean)
          .join(', '),
      };
      console.log(`[maintenance] done — ${maintenance.why}; dispatching resumes`);
      return;
    }

    if (v.act === 'resume') console.log(`[maintenance] ${v.why}`);
  }

  /**
   * The window ids `sweepEmptyWindows` has already reported as refusing to close.
   *
   * Out here rather than inside the sweep because it has to outlive a tick: the whole
   * property of a stuck window is that it does not change, so the same ids come back every
   * time and the list is what turns that into one line each. Fleet-wide for the same reason
   * the sweep below is, and bounded by how many frames iTerm has left on the desk rather
   * than by how long the daemon has been up — see `unreportedStuck`, which is where the
   * forgetting is and why it matters.
   */
  const reportedStuck = new Set();

  /**
   * The fourth sweep, and the only one that is not about a session.
   *
   * The other three all end at a pid: `reapClosing` signals a window this advocate is
   * holding, `sweepWindows` one whose bead is closed, `parkIdle` one that went quiet.
   * Every guard any of them keeps exists because there is an agent in that window whose
   * work would go with it. This one closes windows that have **no tabs at all** — no
   * session, no process, no scrollback, nothing that could still be working — which is
   * why it needs no guards, no grace period and no idle check, and why it is the one
   * sweep that can act the moment it sees its target. See bc-30ve, and the script.
   *
   * **Fleet-wide, not per advocate**, so it hangs off `tick` rather than `tickOne`: an
   * empty frame belongs to no workspace — the session that was in it is gone, and with
   * it every way of telling which repo it had been working. Running it inside the
   * per-advocate loop would ask iTerm the same question once per repo and race itself
   * for the answer.
   *
   * Last in the tick, after every advocate has had its turn, because `reapClosing` is
   * what makes new ones: a window signalled at the top of this tick may be a frame by
   * the bottom of it, and the sweep that runs a minute later is the one that gets it.
   * Nothing is lost by that — an empty window is not urgent, it is only permanent.
   */
  async function sweepEmptyWindows() {
    // No `closeFinishedSessions` in this condition on purpose; see `closeEmptyWindows`
    // in REAP_DEFAULTS for why the two switches are separate. `OBSERVING` is here for the
    // reason it is on the other three: a second daemon watching a live one changes
    // nothing on this Mac, and closing a window is a change however empty the window is.
    if (o.closeEmptyWindows === false || OBSERVING) return;
    let res;
    try {
      res = await sweepEmpty();
    } catch (err) {
      // The real one returns its failures and never throws, so this catches an injected
      // one and a future that changed its mind. It matters because of where this runs:
      // the tick's own catch is in lib/server.js and treats a throw as "the advocate tick
      // failed", which files a crash — a sentence about the whole fleet, over housekeeping
      // that closed nothing.
      console.error(`[advocate] the empty-window sweep threw — ${err.message}`);
      return;
    }
    if (res?.error) {
      // Logged rather than swallowed, and not retried: iTerm refusing to talk to us is
      // the same answer everywhere else in this daemon — worth saying once, never worth
      // hammering — and the next tick asks again anyway.
      console.error(`[advocate] could not close the empty iTerm windows — ${res.error}`);
      return;
    }
    // Only when it did something. This runs every tick against a Mac that is usually
    // tidy, and a line per tick saying "closed 0" is how a log stops being read. What has
    // changed since bc-xl7n.110 is what `closed` means: the script re-queries each window
    // by id after closing it, so this is now a count of frames that went rather than of
    // Apple events that did not raise. The old one was the latter and said so 2,330 times.
    if (res?.closed) {
      console.log(`[advocate] closed ${res.closed} iTerm window(s) with no session left in them: ${res.ids.join(', ')}`);
    }
    // And the other half of it: the ones that took a close and stayed. That is the state
    // bc-30ve was filed to end and that the daemon spent four days reporting as fixed, so
    // it is worth a line — but once each, not once a tick. `unreportedStuck` is what keeps
    // that promise, and why it forgets an id rather than holding it.
    const fresh = unreportedStuck(reportedStuck, res?.stuck || []);
    if (fresh.length) {
      console.log(
        `[advocate] ${fresh.length} iTerm window(s) with no session left in them would not close: ${fresh.join(', ')}`
          + ' — iTerm took the close and kept the window, so it is on the desk until it is dismissed by hand.'
          + ' Said once, not once a tick.',
      );
    }
  }

  /** Beads already reported as having more than one window, so it is said once per spell. */
  const doubleSaid = new Set();

  /**
   * The windows this daemon did not open — bc-7qo.19.
   *
   * On 2026-08-21 three live processes were running the identical worker brief for
   * bc-7qo.11 while this daemon printed `92 ready · at its limit of 2 session(s)` and held
   * one worker row for the bead. Its accounting was not wrong about what *it* had opened;
   * it had no way to be right about anything else, because nothing here ever asked. The
   * three windows had been re-run by shells that outlived their own `claude` processes,
   * which is a route through none of this file.
   *
   * `lib/onewindow.js` is the refusal that stops this daemon adding to such a pile.
   * Nothing can stop a shell, so this is the other half: **say so.** A line in the log is
   * the whole of it, and that is deliberate —
   *
   * - **It signals nothing.** Both windows are working, and choosing between two agents
   *   mid-turn on the strength of a `ps` read is not a decision a sweep gets to make.
   * - **It holds nothing.** The bead already has a worker row; `withoutLiveSessions` is
   *   what keeps a *second* launch off it, and this is not a second opinion on that.
   * - **It is said once per spell**, like `heldByLive` above: a duplicate left open
   *   overnight would otherwise be 2,880 identical lines, which is a log nobody reads.
   *
   * One `ps` for the whole fleet, taken only when some advocate has a worker at all — the
   * same read `withoutLiveSessions` takes, at the same rate, for every workspace at once.
   */
  async function noticeDoubles(order) {
    if (o.holdLiveSessions === false) return;
    const watched = [];
    for (const a of order) for (const w of a.workers) watched.push([a, w]);
    if (!watched.length) {
      doubleSaid.clear();
      return;
    }
    const lines = await psLines();
    const still = new Set();
    for (const [a, w] of watched) {
      // `namesBead` on the *qualified* pair, never a bare id: a worker's argv carries its
      // whole memory store and a memory note quotes bead ids as examples. See
      // `linesNameBead`, which is the same rule and the reason it exists.
      const hits = lines.filter((l) => namesBead(l.args, `${a.name}/${w.id}`));
      if (hits.length < 2) continue;
      const key = `${a.name}/${w.id}`;
      still.add(key);
      if (doubleSaid.has(key)) continue;
      doubleSaid.add(key);
      console.error(
        `[advocate] ${a.name}: ${w.id} has ${hits.length} live windows on it — ` +
          `pid ${hits.map((h) => h.pid).join(', ')}. This daemon opened ${w.pid ? `pid ${w.pid}` : 'one of them'}; ` +
          `the rest came from somewhere else. \`ps -p <pid> -o args -ww\` says which bead each is really on.`
      );
    }
    for (const key of [...doubleSaid]) if (!still.has(key)) doubleSaid.delete(key);
  }

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

      // Before the advocates, because its verdict is what every one of them reads as a
      // dispatch gate — and after `liveSessions`, because it counts what that read found.
      // A window decided halfway down the loop would hold the advocates below it and not
      // the ones above, which is a fleet half stood down.
      await driveMaintenance(order, sessions);

      for (const a of order) {
        try {
          await tickOne(a, sessions);
        } catch (err) {
          a.error = err.message.split('\n')[0];
          console.error(`[advocate] ${a.name}: ${a.error}`);
        }
      }
      // After every advocate, so the worker lists it reads are this tick's rather than
      // last tick's — and before the sweep below, which is about windows with nothing in
      // them at all.
      await noticeDoubles(order);
      // After every advocate, and outside the loop it is not part of: see the header.
      await sweepEmptyWindows();
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
      // The nightly window, on every row rather than once at the top of the payload. It
      // is one fact about the daemon, but the thing that draws it is a *card*, and a card
      // that had to reach outside its own row to find out why its queue is not moving is
      // the shape every other gate here already avoided: `paused` and `quiet` are beside
      // it for the same reason. Null when there is no window on, so a card that knows
      // nothing about this draws nothing.
      maintenance: holdsDispatch(maintenance) ? { phase: maintenance.phase, why: maintenance.why } : null,
      // Switched off and still finishing what it started. On the card because it is a
      // state the switch cannot express — the repo is off, and there is still an
      // advocate here — and a card drawn as plain "on" over it would be inviting you to
      // press Off a second time on something already off.
      draining: Boolean(a.draining),
      limit: a.limit,
      // What the stepper on the card may offer, and the cap it cannot argue with.
      // Both travel so the card never has to hardcode a number the daemon owns: a
      // button that offers 10, or that says nothing about a global cap of 3 holding
      // a limit of 5 down, is a control that misreports what pressing it did.
      ceiling: MAX_WORKERS_CEILING,
      // How many windows one bead may cost before this advocate stops offering it any.
      // It travels for the reason `ceiling` above it does — the card must not hardcode a
      // number the daemon owns — and it is the difference between a pill reading "2 given
      // up on" and one reading "2 given up on after 2 attempts", which is the version that
      // says what to change if the answer is that two was too few. See `givenUp`.
      attemptCap: attemptCap(),
      globalMax: globalLimit(),
      globalHeld: a.limit > globalLimit(),
      // One entry per epic with an advocate assigned — the console draws a card from each,
      // at the same level as the repo advocate's own (bc-henk). Sent whole rather than as a
      // count for the reason every other list here is: a number you cannot open is a number
      // you have to go and check.
      //
      // It is *not* `workers.filter(planning)`. That list is the windows; this is the
      // assignments, and they have different lifetimes — a window that exits leaves its
      // epic still advocated for, and an epic that closes takes its advocate with it
      // whether or not a window is up. See `rosterFor`.
      epicAdvocates: a.epicAdvocates || [],
      // The budget those windows come out of, and the ceiling a stepper may offer. Beside
      // `limit`/`ceiling` above and deliberately separate from them: the card has to be
      // able to say that stepping the worker limit did not change this number.
      epicLimit: a.epicLimit ?? DEFAULTS.maxEpicAdvocates,
      epicCeiling: MAX_EPIC_ADVOCATES_CEILING,
      queue: a.queue.length,
      // Only the top few travel: the card shows what it is about to pick up, and
      // the whole list is a `bd ready` away in the graph.
      // Without the three fields only the launch wants: `labels` is a whole array per row,
      // `repoProblem` is null for everything that reached the queue at all, and
      // `filesBusy` is the same collision the domain-level `filesBusy` below already
      // carries — a second copy per row would be two places on the wire saying one thing,
      // and the row's copy exists for the brief rather than for the card (bc-b9vt).
      next: a.queue.slice(0, 3).map(({ labels, repoProblem, filesBusy, ...b }) => b),
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
        // Which model this window came up on and the tier that picked it (bc-nc6o.2).
        // This is the "selected" half of the epic and the only place it is readable
        // *while the session is still running* — the bead does not carry it, and what the
        // run actually used is not known until it ends. Null on every worker launched
        // before this landed, and on every planner, which the card draws as nothing.
        model: w.model || null,
        tier: w.tier ?? null,
        // And which department this window is spending, when it is spending one — the
        // occupied half of the `capacity:` arithmetic (bc-ogicx.6). It is on the row for the
        // reason `repo` one block up is: the card reports N beads held on a busy department,
        // and this is the only place a reader can see *which* windows are the ones making it
        // busy. Null on every window with no relay, which is all of them today.
        dept: w.dept || null,
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
      // The other closing list: windows that opened and never ran a line, waiting on
      // `reapNeverStarted` to re-confirm and close them. No `pid` and nothing to
      // signal — `term` is the handle, and there is no escalation state to show.
      closingWindows: a.closingWindows.map((c) => ({ id: c.id, title: c.title, term: c.term, at: c.at })),
      // And the windows that are *no longer* windows: conversations parked because their
      // next move is Adam's, each one resumable by id.
      //
      // This is the list the whole feature is for, and it is the one that replaces
      // reading a screen of rectangles: every row is something waiting on him, with the
      // sentence saying what, and none of them is costing a slot or a process. On the
      // card rather than only in `state.json` because a park that is invisible is
      // indistinguishable from a window that was simply killed — which is the objection
      // to closing them at all, and this is the answer to it.
      parked: a.parkedRows || [],
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
      // And the cross-tracker blocks that came off on their own — bc-bmry.7's sweep.
      // Same argument as `superseded`: a bead moving itself back into the queue should
      // be legible from the card, not only from the log.
      farBlocked: a.farBlocked,
      // And the epics whose last child closed while nobody was looking — bc-xl7n.74's
      // sweep. Same argument as `superseded`: a bead moving itself into the inbox is
      // exactly the kind of daemon action that belongs on the card.
      finishedEpic: a.finishedEpic,
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
      // And the ninth, bc-jvt0.4, which is the only one waiting on a judgement: an owned
      // childless epic nobody has said the shape of. The `why` names both ways out, because
      // this is the only hold on the card whose fix is a *decision* — nothing about waiting
      // clears it, and the reader is the one person who can open its advocate.
      heldByUndecided: (a.heldByUndecided || []).map((h) => ({ id: h.id, why: h.why })),
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
      // And the one whose second party is a *bead* rather than a window, a branch, a
      // machine or a claim: another bead this tick was about to open, whose declared
      // surface intersects this one's. The other id travels because it is the whole of the
      // evidence and the only thing to go and look at — there is no window to close and no
      // branch to visit yet, which is exactly why nothing else could report it (bc-42ow.4).
      heldBySurface: (a.heldBySurface || []).map((h) => ({ id: h.id, why: h.why, files: h.files, other: h.other })),
      // And the one that is about no contention at all: a bead nothing has decided should
      // happen. It carries only the id and the sentence, because unlike every other hold
      // here there is no second party to name — no window, no branch, no machine, no file.
      // The fix is on the bead itself, and the sheet is where it is offered (bc-rfnr.7).
      heldByNoRoot: (a.heldByNoRoot || []).map((h) => ({ id: h.id, why: h.why })),
      // And the one whose second party is a ledger entry rather than a bead, a window or
      // a machine: `lib/owed.js` saying this bead's close is mid-retry. The reason travels
      // because it names what landed — see `withoutOwed` and bc-4r10.20.
      heldByOwed: (a.heldByOwed || []).map((h) => ({ id: h.id, why: h.why })),
      // And the one a *repo* asked for: a bead whose department already has as many windows
      // open as its own definition says it may have. The department key travels because it
      // is the only actionable part — the number that would change is written beside that
      // key in a `.beadcause/relays.yaml` a pull request can edit, and no other hold here
      // names something a branch can move. `capacity` and `open` travel with it so the
      // arithmetic on the card is checkable rather than asserted (bc-ogicx.6).
      heldByDept: (a.heldByDept || []).map((h) => ({
        id: h.id,
        title: h.title || '',
        why: h.why,
        dept: h.dept,
        capacity: h.capacity,
        open: h.open,
        tick: h.tick,
      })),
      // And the one that is **not a hold**, which is why it sits outside every list above
      // it: a checkout whose relay definition would not parse or would not validate. Its
      // beads dispatched, exactly as they did before the file existed, without a relay.
      // Carried so the card can say so once, beside the tick note that already does
      // (bc-ogicx.6, and lib/relaydefs.js for what refuses a file and why).
      relayProblems: (a.relayProblems || []).map((p) => ({ why: p.why, id: p.id, repo: p.repo || null })),
      // And the one that is not a subtraction from the queue at all — it is still *in*
      // the queue, counted in the number above it — but that no tick will ever pick up:
      // a bead this advocate has spent `maxAttemptsPerBead` windows on. The attempt count
      // travels beside the id because it is the whole of the evidence, and because the
      // one control that changes it (`forget`) clears every counter at once: pressing it
      // without knowing which beads it re-arms is the reason it went unpressed for days.
      // See `givenUp` and bc-xl7n.111.
      givenUp: givenUp(a),
      // And the one nothing on the machine will ever clear on its own: a bead under an
      // epic somebody paused. The epic id travels because it is the only actionable part
      // — every other hold here names a thing to wait for, and this one names a button to
      // press. See `withoutPausedEpics`.
      heldByPause: (a.heldByPause || []).map((h) => ({ id: h.id, why: h.why, epic: h.epic })),
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
        /**
         * `gone` and not `reclaimed` — bc-y7l2m, and the same fact through a second sensor.
         *
         * `reconcile` reaches this ending by *not finding* a row in a list, which is why it
         * waits out `goneMinutes` before believing it. This is stronger evidence than that
         * and needs no clock: iTerm was asked about a specific window id and answered that
         * it addresses nothing. Both mean the window was closed, and the only thing the
         * ending decides that matters is whether the conversation is carried into the next
         * window or thrown away — so answering the same question two different ways
         * depending on which sweep noticed would be an accident of timing, not a decision.
         *
         * The branch above stays `reclaimed`, and the difference is exact: `!w.term` is a
         * slot freed *without asking*, on the word of whoever pressed the button. Nothing
         * was measured there, so there is nothing to conclude about the conversation.
         */
        finish(a, w, 'its window is gone — the slot is free', 'gone');
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
    /**
     * And the half the button could not do before: the windows that are **not** on the
     * slot list.
     *
     * Every one of the three outcomes above is about a *worker*, and the pile Reclaim is
     * pressed at is mostly not made of workers — it is resolvers, advocates and merge
     * windows, which take no slot and which the old button could not see, let alone free.
     * Worse, the button was hidden entirely when there were no workers (bc-2uj4.5.3), so
     * the state with thirteen orphaned windows on screen was the state with no button.
     *
     * So a press now also parks whatever this advocate opened and is quiet *right now* —
     * `idleMinutes: 0`, because the press is the judgement the grace period otherwise has
     * to infer. Nothing busy is touched, and nothing is closed that was not written down
     * first; see `parkIdle`.
     */
    const before = (a.parkedRows || []).length;
    const sessions = (a.liveSessions || []).filter((s) => s.workspace === a.name);
    parkIdle(a, sessions, { idleMinutes: 0 });
    const parkedNow = Math.max(0, (a.parkedRows || []).length - before);
    /**
     * And the windows in this repo that are **nobody's to close** — counted, never acted
     * on.
     *
     * A window this daemon did not open is one somebody opened by hand, and closing those
     * was considered and deliberately not built: it is the one version of this feature
     * that can take away a window you were about to type into. But saying nothing about
     * them is its own small dishonesty, because the pile on screen does not distinguish
     * them and a press that reports "parked 4" over a screen of nine leaves you counting
     * the other five yourself. So the sentence names them and stops there.
     */
    const held = new Set([...a.workers.map((w) => w.sessionId).filter(Boolean), ...(a.parkedRows || []).map((p) => p.sessionId)]);
    const notOurs = sessions.filter((s) => s.sessionId && !held.has(s.sessionId)).length;
    const detail = [
      asked ? `asked ${asked}` : '',
      freed ? `freed ${freed}` : '',
      parkedNow ? `parked ${parkedNow}` : '',
      notOurs ? `${notOurs} this daemon did not open, left alone` : '',
      unreachable ? `${unreachable} unreachable` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'nothing to reclaim';
    console.log(`[advocate] ${a.name}: reclaim — ${detail}`);
    emit(a, 'reclaimed', { detail });
    return { asked, freed, unreachable, parked: parkedNow };
  }

  /**
   * Pause or resume one epic's advocate — the button in the head of its card on the console.
   *
   * **Three things stop and one thing does not**, and the one that does not is the whole
   * shape of the feature. What stops: `reenter` no longer opens a window on this epic,
   * `withoutPausedEpics` holds every ready bead under it out of the queue, and the launch
   * door in lib/server.js refuses. What does not stop: **the windows that are already
   * open**. They keep their slots, keep their claims, and are expected to reach an ending
   * of their own — a pause that killed them would lose the half-finished work it was
   * pressed to protect, and "let the current agents finish" is the request.
   *
   * So the live windows are *told*, and the message is the second half of the feature
   * rather than a courtesy. A session ordinarily hands its unfinished thinking to the
   * next window on the bead half an hour later; a pause is a promise that there will not
   * be one, so `pauseMessage` asks each of them for the debrief before they exit, and
   * `debriefBrief` is what hands it to whatever opens after the resume. Without that,
   * pausing an epic mid-flight would be the most expensive way this system has of
   * forgetting something.
   *
   * **The label is written first and the rest follows from it.** `bd label add` is one
   * atomic operation on the shared graph, so the fact reaches another Mac, survives this
   * daemon dying between the two halves of this function, and cannot be lost with
   * `advocates.json`. `a.pausedEpics` is updated straight after only to close the gap
   * until the next `rosterFor` re-derives it — `bd.graph` is cached for a minute, and a
   * button whose effect waits on a cache is a button you press twice.
   *
   * A failure to message a window is **not** a failure to pause. iTerm refusing an Apple
   * event, or a window that has already gone, must not leave the epic running: the label
   * is written, the queue is already holding, and the honest report is "paused, and I
   * could not reach two of the windows" rather than an exception that undoes it.
   */
  async function epicPause(a, id, paused) {
    const bead = String(id || '').trim();
    if (!bead) throw Object.assign(new Error('which epic?'), { status: 400 });
    const epic = (a.epicAdvocates || []).find((e) => e.id === bead) || null;
    const title = epic?.title || '';

    if (paused) await bd.addLabel(a.workspace, bead, PAUSED_LABEL);
    else await bd.removeLabel(a.workspace, bead, PAUSED_LABEL);
    a.pausedEpics = new Set(a.pausedEpics || []);
    if (paused) a.pausedEpics.add(bead);
    else a.pausedEpics.delete(bead);

    let told = 0;
    let unreachable = 0;
    if (paused) {
      // Every window this advocate is holding whose bead is the epic or under it — the
      // batch included, because a batch head's window is briefed on every id in it and is
      // as much "a session working under this epic" as the head is. The same `underEpic`
      // the rest of the file uses, so this and the queue filter can never disagree about
      // which windows a pause is about — and since bc-b2k.2 that means the edges, so a
      // window on an adopted child is told to stop like any other.
      //
      // This is a button rather than a tick, so the export it reads may be the last tick's:
      // up to one `pollSeconds` stale, exactly as `a.pausedEpics` and the roster are, and a
      // reparent inside that window costs one message rather than a wrong pause — the label
      // is already written and the queue is already holding by the time this runs.
      const parents = await tickParents(a);
      const under = (w) =>
        [w.id, ...(w.batch || [])].some((x) => x === bead || underEpic(x, bead, parents));
      for (const w of a.workers.filter(under)) {
        if (!w.term) {
          // Launched before the window id was recorded, so there is nothing to address.
          // It keeps its slot and finishes on its own brief — which is what it would have
          // done anyway; it just will not hear that it is the last one for a while.
          unreachable += 1;
          continue;
        }
        try {
          const answer = await say(w.term, pauseMessage(w.id, bead, { title }));
          if (answer === 'missing') unreachable += 1;
          else told += 1;
        } catch (err) {
          // Deliberately not `finish`: `reclaim` reads an unreachable window as a slot to
          // take back, and here it is nothing of the sort. We failed to deliver a message
          // to a session that is very likely still working.
          console.error(`[advocate] ${a.name}: could not reach ${w.id}'s window — ${err.message}`);
          unreachable += 1;
        }
      }
    }

    const detail = paused
      ? [
          `paused ${bead}`,
          told ? `told ${told} ${told === 1 ? 'window to write its debrief' : 'windows to write their debriefs'}` : '',
          unreachable ? `${unreachable} could not be reached` : '',
        ]
          .filter(Boolean)
          .join(', ')
      : `resumed ${bead}`;
    console.log(`[advocate] ${a.name}: ${detail}`);
    emit(a, paused ? 'epic-paused' : 'epic-resumed', { id: bead, detail });
    return { id: bead, paused, told, unreachable };
  }

  async function control(name, action, value) {
    const a = advocates.get(name);
    if (!a) throw Object.assign(new Error(`no advocate for ${name}`), { status: 404 });
    if (action === 'epicPause' || action === 'epicResume') {
      // The bead id travels in `value`, which is the same slot the limit stepper uses:
      // `control` is the one door to /api/advocate and it takes one argument beyond the
      // action, so a second door for this would be a second contract to keep in step.
      return await epicPause(a, value, action === 'epicPause');
    }
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
   * Give a workspace an advocate, now, without a restart.
   *
   * Both halves, and the second is the one whose absence you would notice a week later:
   * `saveAdvocated` writes the opt-in list so the next `launchctl kickstart` still has
   * it, and the record built here is what makes the *running* daemon tick for this repo
   * thirty seconds from now. Writing only the file is the failure this bead is about —
   * enabling climative on 2026-08-11 took a node script and a swap, and the console gave
   * no hint the setting existed.
   *
   * Idempotent in both directions. Switching on a repo that is already on is a repaint,
   * not an error — the page you pressed it from may be twenty seconds stale — and
   * switching on one that is *draining* takes the drain off and gives its open sessions
   * back to the advocate that opened them, which is the only sensible reading of pressing
   * On over "switched off, 2 still running".
   */
  function enable(name) {
    const ws = (cfg.workspaces || []).find((w) => w.name === name);
    if (!ws) throw Object.assign(new Error(`no configured workspace called ${name || '(none given)'}`), { status: 404 });
    saveAdvocated(cfg, name, true);
    // The daemon's own view of the list, kept in step with the file it was read from.
    // Nothing in the tick reads it today — `advocatedWorkspaces` takes `cfg` — but a
    // copy that silently disagrees with the config is the sort of thing that is only
    // ever found by the next person to trust it.
    o.workspaces = cfg.advocates.workspaces;
    const had = advocates.get(name);
    if (had) {
      had.draining = false;
      had.note = '';
    } else {
      advocates.set(name, record(ws, loadState()[name] || {}));
    }
    const a = advocates.get(name);
    console.log(`[advocate] ${name}: switched on`);
    emit(a, 'enabled', { detail: 'given an advocate from the app' });
    persist();
    return a;
  }

  /**
   * Take a workspace's advocate away — and let the sessions it opened finish.
   *
   * The drain is the whole of the design. An advocate holds the only record of the iTerm
   * windows it opened: which bead each is on, whether it has claimed it, when to ask it
   * to check in, when its bead closed and the window may be signalled. Dropping the
   * record the moment the switch is flipped would leave those windows running with
   * nobody watching them — no reap, no archive, no check-in — which is a worse thing to
   * do to a session than either state the switch is supposed to be picking between.
   *
   * So a disable with workers open keeps the record and marks it `draining`: `tickOne`
   * runs every sweep it already ran and stops before the survey, so nothing new is
   * launched and nothing running is touched. The record goes on the first tick that
   * finds it empty. A disable with nothing open is that same end state reached
   * immediately.
   */
  function disable(name) {
    const a = advocates.get(name);
    if (!a) throw Object.assign(new Error(`no advocate for ${name || '(none given)'}`), { status: 404 });
    saveAdvocated(cfg, name, false);
    o.workspaces = cfg.advocates.workspaces;
    const open = a.workers.length + a.closing.length + a.closingWindows.length;
    if (open) {
      a.draining = true;
      a.note = '';
      a.queue = [];
      console.log(`[advocate] ${name}: switched off — ${open} session(s) left to finish`);
      emit(a, 'disabled', { detail: `switched off from the app — ${open} session(s) left to finish` });
      persist();
      return a;
    }
    console.log(`[advocate] ${name}: switched off`);
    emit(a, 'disabled', { detail: 'switched off from the app' });
    advocates.delete(name);
    persist();
    return null;
  }

  /**
   * Every configured workspace, and whether it can have an advocate switched on — which
   * is the half of this the console could never work out for itself.
   *
   * A card for a repo with no advocate has always said "no advocate" and stopped there,
   * because the three reasons it might have none live in three settings the page cannot
   * see (see `switchBlocked`). A switch drawn over that guess would be a button that
   * writes a setting and changes nothing, for two of the three. So the daemon says which
   * it is, and the page draws either the switch or the sentence.
   */
  const roster = () =>
    (cfg.workspaces || []).map((w) => {
      const a = advocates.get(w.name);
      const blocked = switchBlocked(cfg, w.name);
      return {
        workspace: w.name,
        advocated: Boolean(a) && !a.draining,
        draining: Boolean(a?.draining),
        can: !blocked,
        why: blocked,
      };
    });

  /**
   * The numbers that belong to no repo — what the console's global row is drawn from.
   *
   * `live` is counted here rather than on the page because the page is filtered by
   * space and this cap is not: a total taken over the three advocates you happen to be
   * looking at would read as headroom that does not exist.
   */
  const globals = () => ({
    maxWorkers: globalLimit(),
    ceiling: GLOBAL_WORKERS_CEILING,
    live: totalWorkers(),
    // Counted into the same cap and reported separately, which is the shape the console
    // row needs: a total of 20 with 18 workers is not headroom of 2 if two resolvers are
    // running, and the only place that can be said is beside the number it qualifies.
    resolvers: totalResolvers(),
  });

  return {
    tick,
    snapshot,
    control,
    globals,
    setGlobalLimit,
    enable,
    disable,
    roster,
    /**
     * What the re-entry sweep last decided about one epic — `{ at, hold }`, or `null`.
     *
     * For the board card, which is drawn in lib/server.js on a request path and may not do
     * anything that costs a `bd` call. This is a `Map` get and a property read off state
     * the daemon has already persisted (`advocated[id]`, advocates.json), so a board of
     * twelve cards asking it twelve times costs nothing.
     *
     * One epic at a time rather than the whole map, because that is the grain the card
     * has — and `null` for a workspace with no advocate is the honest answer rather than
     * an empty record: nothing is sweeping there, so nothing is holding anything either.
     */
    advocacy: (workspace, id) => {
      const a = advocates.get(String(workspace || ''));
      const rec = a?.advocated?.[String(id || '')];
      return rec ? { at: rec.at || null, hold: rec.hold || null } : null;
    },
    /**
     * Take the attempt charges off **one** bead — the per-bead half of `forget`.
     *
     * `maxAttemptsPerBead` is a floor nothing decrements: it is cleared on the four
     * endings that are not failures (`closed`, `delivered`, `handback`, `stood down`) and
     * on nothing else, all four of them inside `reconcile`, all four of them about a
     * window *this advocate opened*. A hand-back that **you** asked for is none of those
     * and reaches none of them — lib/server.js's `handBackWorkBead` writes the tracker and
     * this map is in the daemon's memory — so `Request changes` on a delivery card put the
     * bead back in `bd ready` and left `candidates` refusing it for ever, while the card
     * said "back in the queue". That is bc-xl7n.117, and bc-xl7n.87 is the bead it happened
     * to: both of its advocate windows timed out at two hours and charged an attempt, the
     * pull request was made later by a session the daemon never opened, so nothing ever
     * cleared them.
     *
     * **Which is a commission and not a retry**, and that is the whole argument for
     * clearing rather than counting: the reasoning `reconcile` already states out loud for
     * `delivered` and `handback` — "documented endings the brief asks for, so neither costs
     * an attempt" — is the same reasoning one step later. Somebody read the diff and asked
     * for a change; the two windows that died before it are not evidence about the work
     * that was asked for now.
     *
     * **Not a second `forget`.** That button clears every counter in the workspace, which
     * is the right shape for "I have read the list and none of these deserve it" and the
     * wrong one for a single card being answered — a bead that really does break every
     * window it gets must keep its charges when its neighbour is handed back. So this takes
     * an id, and it says how many charges it found: a caller that cleared nothing has
     * nothing to tell anybody, and a caller that cleared a *retired* bead has the one
     * sentence worth putting on the card.
     *
     * A workspace with no advocate answers zero, which is the honest answer rather than a
     * throw: nothing there has a queue to be retired from, and the hand-back that called
     * this is not less true for it.
     */
    rearm: (workspace, id) => {
      const cap = attemptCap();
      const a = advocates.get(String(workspace || ''));
      const bead = String(id || '').trim();
      const charges = (a && bead && a.attempts[bead]) || 0;
      if (!charges) return { charges: 0, cap, retired: false };
      delete a.attempts[bead];
      persist();
      const retired = charges >= cap;
      console.log(
        `[advocate] ${a.name}: cleared ${charges} attempt charge(s) on ${bead}` +
          (retired ? ` — it was retired at ${cap} of ${cap}, and a window can open on it again` : '')
      );
      // The console draws `givenUp` off the snapshot, and a card still showing the bead in
      // the retired list is the same lie one screen along. Same event as `forget`, because
      // it is the same fact having happened to fewer beads.
      emit(a, 'forgot', { id: bead, detail: `${charges} attempt charge(s) cleared on ${bead}` });
      return { charges, cap, retired };
    },
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
 * Every list a bead can be sitting in when it is ready and still not in the queue, and
 * the sentence that says why — for `queueBrief`, which has to hand the survey agent the
 * *reason* its own `bd ready` disagrees and not merely a number.
 *
 * A second spelling of the tick's own phrases, deliberately, because the two are for
 * different readers: the fragments in the tick build a card (` · 3 waiting on their
 * children`) and these are for an agent that is about to go looking. What stops the two
 * drifting apart into a hold nobody reports is not discipline but `test/surveybrief.mjs`,
 * which fails the repo for any `heldBy*` field of the agent record that has no row here.
 * A tenth hold list is a red test, not a silently missing paragraph.
 */
export const QUEUE_HOLDS = [
  { field: 'heldByChildren', why: 'their children are the work, so the child is dispatched and the parent waits' },
  {
    field: 'heldByUndecided',
    why: 'they are childless epics somebody owns, and nothing has yet decided whether each is one job or several — their advocate does that',
  },
  { field: 'heldByNoRoot', why: 'nothing on the board has decided they should happen — no root above them' },
  { field: 'heldByPause', why: 'the epic above them has been paused' },
  { field: 'heldByPr', why: 'an open pull request already carries the work' },
  { field: 'heldByLive', why: 'a session is already open on them' },
  { field: 'heldByTwin', why: 'they are the same job as work already under way' },
  { field: 'heldByLease', why: 'another Mac has claimed them in the shared tracker' },
  { field: 'heldByClaim', why: 'another session on this Mac is editing the files they would touch' },
  { field: 'heldBySurface', why: 'another bead this tick is opening declared the same files, so they wait a tick' },
  { field: 'heldByRepo', why: 'they name no checkout this workspace can be worked in' },
  { field: 'heldByOwed', why: 'their merge-bead already closed on a merge and their own close is still retrying' },
  {
    field: 'heldByDept',
    why: 'their department already has as many windows open as its own `.beadcause/relays.yaml` says it may have — a `capacity:`, which only ever subtracts',
  },
];

/**
 * The paragraph that tells the survey agent what "your queue is empty" actually means.
 *
 * It exists because the sentence it replaces was **falsifiable in one command, and got
 * falsified**. The prompt used to open *"there is no ready work left in this repo's beads
 * tracker"*; on the one real survey this Mac has run (`architecture`, 2026-08-12) the
 * agent's third line was *"The stated premise — an empty queue — doesn't match reality
 * here; there are 49 ready beads"*, its write-up opened *"First, the premise was wrong"*,
 * and it wrote a cross-repo memory telling every future survey not to trust what it is
 * told. A brief that teaches the agent to distrust briefs is worse than a vague one, and
 * it spent its opening moves re-deriving what this daemon was already holding.
 *
 * So the claim is narrowed to one that is true — nothing in *my* queue — and the
 * subtractions between the two lists are named, with the numbers attached. The agent's
 * `bd ready` is the unfiltered list and cannot be made to agree: `Bd.ready` forces the
 * label exclusions on whatever the caller asks for (lib/bd.js), which is right, so the
 * disagreement is permanent and the only fix is to predict it.
 *
 * **The counts are what turn this from an apology into the most useful paragraph here.**
 * A survey that knows twelve beads are waiting on endorsement can say *that* instead of
 * proposing a thirteenth beside them — which is a better answer to "is this genuinely
 * finished" than anything it would have found in the source.
 *
 * Every number is optional and a missing one is omitted rather than printed as zero: the
 * two counts come from `bd` calls that are allowed to fail (see `propose`), and "0 waiting
 * on endorsement" and "I could not ask" are different claims.
 */
export function queueBrief(a = {}, o = {}, extra = {}) {
  const max = clampInt(o.minPriority, 0, 4, DEFAULTS.minPriority);
  const deferred = extra.deferredByPriority ?? a.deferredByPriority ?? 0;
  const { heldForEndorsement = null, shipWaiting = null, owner = ownerName() } = extra;

  // Nine in principle; in practice always zero, and saying so is worth more than nine
  // zero lines. `propose` is reached from one place, on a tick where the queue is empty
  // *and* every one of these is — see `quiet`. Derived rather than asserted, because a
  // future second caller without that gate should get the counts and not the promise.
  const holds = QUEUE_HOLDS.map((h) => ({ ...h, n: (a[h.field] || []).length })).filter((h) => h.n);

  const labelCounts = [
    heldForEndorsement === null ? null : `**${heldForEndorsement}** ready bead(s) carry \`unendorsed\``,
    shipWaiting === null ? null : `**${shipWaiting}** are \`ship\` beads waiting on a deploy`,
  ].filter(Boolean);

  return `**"Empty" is my queue after its filters, not the tracker — and your own \`bd ready\`
will not agree with me.** Run it and it may well return rows. Yours is the unfiltered
list; mine is that list minus the subtractions below, and \`Bd.ready\` forces those
exclusions on every caller, so the disagreement is permanent and expected. **It is not a
contradiction of this brief, so do not spend your opening moves proving it wrong** — the
numbers you would have gone looking for are right here.

- **Four labels never reach my queue** (\`QUEUE_EXCLUDED\`, lib/endorse.js). \`human\` — a
  question that is ${owner}'s to answer rather than work. \`unendorsed\` — filed by an
  agent and not yet approved, so nothing may open a session on it. \`ship\` — a merged pull
  request waiting on a deploy, which only a tap closes. \`container\` — a standing root
  other beads are filed under, which is furniture rather than work. Beads marked
  \`superseded-by:<id>\` are out as well, and so are beads marked
  \`blocked-by:<workspace>/<id>\` — a blocker in a different tracker, which no edge here
  can express.${labelCounts.length ? ` ${labelCounts.join(', and ')}.` : ''}
- **Priority.** ${
    deferred
      ? `**${deferred}** ready bead(s) sit below the floor — worse than P${max}, which this workspace treats as a backlog rather than as work.`
      : `Anything worse than P${max} is a backlog rather than work here, and nothing ready was.`
  }
- **${
    holds.length
      ? `Held back this tick:**\n${holds.map((h) => `  - **${h.n}** — ${h.why}.`).join('\n')}`
      : `Nothing was held back by contention.** I run only on a tick where all ${QUEUE_HOLDS.length} of my hold lists are empty, so take as given that no ready bead here is waiting on a child, an open pull request, a live session, another Mac's claim, a paused epic, a busy file, a missing checkout, a merge-bead still retrying its own close, a department already at the ceiling its own repo declared, or a decision nobody has made about how a childless epic splits. Nothing is hiding behind those.`
  }

**Let those numbers change what you propose.** A tracker with beads waiting on endorsement
or sitting below the floor is not an empty tracker, and the honest answer to "is this
genuinely finished" may be a sentence about them rather than a new bead beside them. Work
already tracked is never something to propose again — but \`bd label add <id> human\` is
yours to use, and one bead routed to ${owner} beats a proposal they have to compare
against it.`;
}

/**
 * `repoBrief` is tier 3 (lib/agentrepo.js) and is empty on most installs and on every
 * run of the `off` setting — an unset affordance has to read as one that does not exist,
 * not as a heading with nothing under it.
 *
 * It goes after the memory brief and before the reflection, which is where it belongs in
 * both directions: the agent should have read what it *knows* before being handed
 * somewhere with nothing decided about it, and the reflection stays last so that the
 * question "was there something you could not do" is the most recent thing in context.
 *
 * `queue` is `queueBrief` and it is **not** optional in the way the rest of these are.
 * The opening claim used to be that the tracker had no ready work in it, which is a
 * different and falsifiable claim — see `queueBrief` for what happened. A caller that
 * passes nothing still gets a narrowed premise, because the sentence itself no longer
 * says anything about the tracker; what it loses is the numbers.
 */
function surveyPrompt(
  workspace,
  o,
  reflection = '',
  owner = ownerName(),
  repoBrief = '',
  wiki = '',
  checkouts = '',
  queue = ''
) {
  return `You are the **${workspace} advocate** in beadcause. Your queue is empty — nothing
left in it after the filters below — and your job is to decide whether that is genuinely
finished or merely untracked.
${queue ? `\n${queue}\n` : ''}${checkouts ? `\n${checkouts}` : ''}
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

**And the tracker now says how earlier ratings turned out.** A finished session leaves
\`ctx:fit\`, \`ctx:tight\` or \`ctx:over\` on its bead — \`over\` means it ran out of
context on the model its tier picked and spent part of an unattended hour compacting;
\`tight\` means it fitted with little to spare. \`bd list --label ctx:over\` is the list of
beads whose tier was wrong, and it is worth reading before you rate work that resembles
one of them.

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
