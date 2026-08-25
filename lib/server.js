import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bd } from './bd.js';
// The base branch this workspace merges into — its own where it has one, `pr.base`
// otherwise. Every one of the three reads below is a *fallback* for a record that
// carries no base of its own, so this is the setting rather than `baseFor`'s per-repo
// answer. See lib/prbase.js.
import { configuredBase } from './prbase.js';
import { endorse, isHeld as isUnendorsed } from './endorse.js';
import { endorsementsIn, endorsementNote, endorsementResult } from './endorseanswer.js';
import { prefixOf } from './mentions.js';
import { release, isSuperseded } from './superseded.js';
import {
  applyVerdict,
  loadBead,
  normalizeEdits,
  parseIds,
  statusFor,
  verdictBody,
  EDITABLE,
  MAX_IDS,
  REVOKED_PREFIX,
  REVOKED_REASON,
} from './verdict.js';
import { isEpic, isRoot, ownedByMe, ownerUpdate, ownersOn } from './ownership.js';
import { ancestorsOf, childrenFrom, treeUnder, underAnyOf } from './ancestry.js';
import { searchBeads, SEARCH_LIMIT } from './beadsearch.js';
import { hasRootAbove, rootsOf } from './underroot.js';
import { withDiscoveredFrom } from './filing.js';
import { homeIn } from './homing.js';
import {
  ADVOCATE_LABEL,
  advocacyOn,
  advocateSession,
  isAssigned,
  isCrash,
  openedRecently,
  rememberAdvocateOpened,
  waitingOn,
} from './epicadvocate.js';
import { corpusDir, loadCorpus, requirement } from './requirements.js';
import { edgesFor, everything } from './reqindex.js';
import { coverage, describeCoverage } from './reqcoverage.js';
import { control, corpus as controlCorpus, crosswalk, satisfiedBy } from './controls.js';
import { edgesFor as controlEdgesFor, everything as controlGraph } from './controlindex.js';
import { coverage as controlCoverage, describeCoverage as describeControlCoverage } from './controlcoverage.js';
import { formatPlan, readPlan } from './plan.js';
import { awaitingEndorsement, endorsementQueue, forget as forgetQueue, warm as warmQueue } from './endorsequeue.js';
import { say, threadOf, DISCUSS_MAX } from './discuss.js';
import { toQuestion, optionById } from './decision.js';
import { parseGraph, enrichGraph, movedSince, workspaceGraph, warmGraphs } from './graph.js';
import { collectWork, shortActor, workKey } from './work.js';
import { liveSessions } from './claude.js';
import { tailTranscript } from './transcript.js';
import {
  pushQuestion,
  pushReply,
  pushFoundationRequest,
  pushFoundationReply,
} from './notify.js';
// The three classes of arrival that tell you something rather than ask you something.
// They used to be ntfy pushes in lib/notify.js beside the four above; they are events on
// the bus now, so the phone draws them itself. See lib/news.js for what did not move.
import {
  landedEvent,
  deployEvent,
  deployClearEvent,
  syncStuckEvent,
  syncFlappingEvent,
  syncClearEvent,
  epicDoneEvent,
  mutedNews,
} from './news.js';
// The second delivery surface for the same decision. Imported like lib/notify.js beside
// it — a leaf on config and spaces, so it adds no edge to the graph that lib/server.js
// does not already have.
import { postQuestion as postToSlack, settleQuestion as settleSlack } from './slack.js';
import { loadState, saveState, saveConfig, CONFIG_PATH, OBSERVING, OBSERVING_NOTE } from './config.js';
// After config.js, deliberately: lib/confluence.js reads CONFIG_DIR from it, and the
// import graph here is one an ordering mistake has already broken once (bc-u4na).
import {
  settings as confluenceSettings,
  problem as confluenceProblem,
  target as confluenceTarget,
  publish as confluencePublish,
  publishKey as confluencePublishKey,
  tokenFileWarning as confluenceTokenWarning,
  prunePublished,
} from './confluence.js';
import { tokenFileWarning as jiraTokenWarning } from './jira.js';
import { publicRoster, addAgent, removeAgent, agentFor, acknowledged, acknowledge, withAgentNames } from './agents.js';
import { reportSweepFailure } from './crash.js';
import { createEventBus } from './events.js';
import { createChangeDetector, detectIntervalMs } from './detect.js';
import { intake as intakeError, isNewBead, ERROR_LABEL } from './errors.js';
// Only the bind-failure exit code, and lib/startup.js imports nothing at all, so this
// costs the import graph nothing — see the note at the top of it.
import { PORT_TAKEN_EXIT } from './startup.js';
import {
  messageSession,
  openConflictSession,
  openMergeAdvocateSession,
  openReviewAdvocateSession,
  openReviewAnswerSession,
  openEpicAdvocateSession,
  openHandoffSession,
  openSession,
  openShipSession,
  openWorkSession,
  resolveSessionDir,
  sessionReach,
  terminalPrompt,
} from './session.js';
import { multiRepo, repoList, reposBlock, splitRepoKey, unitFor, whereLanded } from './repos.js';
import { bringUp, isHeld, putBack, touch as touchFocus } from './focus.js';
import { authorOf } from './prauthor.js';
import {
  collectBoard,
  forgetBoard,
  landLocally,
  landParent,
  narrowBoard,
  offBoardRows,
  openBaseCards,
  pickCard,
  warmBoard,
} from './prboard.js';
import { describeSweepOutcome, requestSweep, sweepMerged } from './mergesweep.js';
import {
  RECOVER_EVERY_MS,
  describeSweepCard,
  followSweepCards,
  locate,
  markResolving,
  readSweepCards,
  recoverSweepCards,
  sweepAnswer,
  sweepCardBody,
} from './sweepcard.js';
import {
  anyArmed,
  decorateBoard,
  loadLedger,
  releaseFor,
  shipReason,
  sweepReleases,
  sweepVoice,
} from './release.js';
import { forgetMerges, gatherMerges, queues } from './queues.js';
import { listHandovers } from './handover.js';
import {
  closeTerminal,
  getTerminal,
  listTerminals,
  openTerminal,
  resumeTerminal,
  suspendTerminal,
  summary as terminalSummary,
  terminalsEnabled,
} from './terminal.js';
import { archivedBeads, readArchive, readArchived, readSessionDetail } from './sessionlog.js';
import { createAuditor } from './sessionaudit.js';
import { skillsView } from './skills.js';
import { ledger as beadLedger, parseQuery as parseLedgerQuery } from './history.js';
import { dispatchReply, agentBusyOn, busyAgents } from './dispatch.js';
import { createAdvocates, PROPOSAL_LABEL } from './advocate.js';
// One export, and it is a read of three fields of a row this file already has — see the
// `advocacy` field on `rootCard`. lib/finishedepic.js gained imports with bc-jvt0.5 and
// this still costs the server no new module: all three — lib/container.js, lib/plan.js and
// the two main-ancestry modules — already arrive through lib/advocate.js above.
import { alreadyAsked } from './finishedepic.js';
import { createAdmin } from './admin.js';
import { createDeviceStore, deviceLabel, newDeviceId } from './devices.js';
import { deployFor, deployHint, deployable, startDeploy, listDeploys, showDeploy, briefDeploy, deployLog, keyOf, runningFor, whereOf, reportingQuiet, sweepDeploys, unannounced, markAnnounced, deployTrouble, ownWorkspace } from './deploy.js';
// What a settled deploy did to the client asking — see the header of lib/update.js.
import { deployEffects, updateView } from './update.js';
import { filePass, normalizePass } from './edits.js';
import { parseProposal, isApproval, parseApproval, applyEdits, dupeNote } from './proposal.js';
import { complexityLabels } from './complexity.js';
import { modelCard } from './modelcard.js';
import { approvalCard } from './approvalcard.js';
import { relayTrail } from './relayjournal.js';
import { annotateDuplicates, findDuplicate, liveCandidates } from './dupe.js';
import { resolveAmendment, AMENDMENT_LABEL } from './amendment.js';
import { deliveryAction, parseDelivery, cardsForDelivery, slugOf, DELIVERY_LABEL } from './delivery.js';
import { sweepMergeQueue, describeMergeQueue } from './mergequeue.js';
// The review block's half of a merge-bead — what both windows of a round are briefed from:
// the reviewer that has not looked yet (bc-36xx.5) and the worker whose pull request it has
// left comments on (bc-36xx.4).
import { MAX_REVIEW_ROUNDS, nextReviewRound, reviewState } from './mergebead.js';
import { markMerged as markWindowMerged, describeMarked } from './retitle.js';
import { tellEpicAdvocate, describeNudge } from './followupnudge.js';
import { anyQueued } from './mergeadvocate.js';
import { raiseMergeCard } from './mergeraise.js';
import { sweepBase } from './redbase.js';
import { oweClose, forgetOwed, sweepOwed } from './owed.js';
import { sweepAdoptions, describeRefusal } from './adoptsweep.js';
import { sweepDuplicates } from './dupesweep.js';
// The half of bc-eqn1.7 that has to run on a clock: an archive with a retention period and
// nothing enforcing it is a policy document. See `sweepAgentLogs`.
import { dispose as disposeAgentLogs } from './agentarchive.js';
import { reapStrays, describeStrays, sweepMs as strayMs, mayReap } from './strays.js';
import { ownerName } from './owner.js';
import { accountAgainst, find as findResolver, pending as pendingResolvers, resolveFor, setMaxLive } from './resolvers.js';
import { certificate, closeServer, daysLeftOf, isSecure, tailnetServer, tlsEnabled, MIN_VERSION } from './tls.js';
import { setTls, tlsView } from './tlsswitch.js';
import { routerHealth, serviceHealth } from './service.js';
import {
  CALLBACK_PATH,
  FLIGHT_COOKIE,
  SESSION_COOKIE,
  beginSignIn,
  claimsOf,
  clearCookie,
  allowed as emailAllowed,
  exchange,
  googleAuth,
  googleProblem,
  paired,
  pairCookie,
  parseCookies,
  safeEqual,
  safeNext,
  secretFileWarning,
  secureCookies,
  sessionCookie,
  sessionKey,
  verify as verifySigned,
} from './auth.js';
import * as pr from './pr.js';
// Per-request timing, and the one thing every request on this server passes through.
// A leaf on nothing at all, so it adds no edge to the import graph — see the note at
// the top of it, and `timing.instrument` at the head of the handler.
import * as timing from './timing.js';
import {
  KEPT_HEADER,
  WAIT_MS as CACHE_WAIT_MS,
  combine as combineKept,
  describe as describeKept,
  peek as cachePeek,
  read as cacheRead,
  drop as cacheDrop,
  dropPrefix as cacheDropPrefix,
} from './cache.js';
import * as agentlog from './agentlog.js';
import {
  createConsole,
  getConsole,
  listConsoles,
  pruneConsoles,
  recordCreated,
  sendTurn,
  setDraft,
  waitForConsole,
  reseedConsole,
  consolesFor,
  closeConsole,
} from './console.js';
import { declaredFiles, withoutSurface, withSurface } from './beadfiles.js';
import { normalizeDraft, normalizePriority, topoOrder, TYPES as BEAD_TYPES } from './draft.js';
import { filterProposedLabels } from './proposedlabels.js';
import { applyEdges } from './edges.js';
// Two different "agents" now share this file, so the kinds are imported under a name
// that says which: lib/agents.js is the roster of reply personas you choose between,
// lib/agentview.js is the screen over the four agent KINDS and their foundations.
import { agentList, agentDetail, agentLog, logKeyFor, AGENTS as AGENT_KINDS } from './agentview.js';
// The map, and the amendment endpoints. `all` is aliased because `agentList` above
// already answers "every agent" for a different screen, and two imports called some form
// of `all` in one file is how the wrong one gets used.
import { all as allFoundations, amend, decline, displayName } from './foundation.js';
import { flowchart, mermaidFor } from './flowchart.js';
import {
  spaceFor,
  summarise,
  reconcileFilter,
  quietReasonFor,
  describeFilter,
  isQuiet,
  spaceDetail,
  applySettings,
  applyWorkspaceSettings,
  prPolicyFor,
  autoEndorseAllowed,
  spaceSlug,
  SCOPE_ROOT,
} from './spaces.js';
// What the configured roots and `workspaceDirs` between them say this Mac serves. Asked
// by `/api/workspaces` for the three things only discovery knows: where a tracker being
// brought back actually lives now, whether one is findable at all, and — for a bead-space
// being added — whether looking would have found it anyway, which is what decides between
// a `workspaceDirs` pin and no config line at all.
import { discoverWorkspaces, isDiscoverable } from './workspaceroots.js';
// Adding one from the app: a path, or a GitHub URL. Every refusal and every config write
// lives over there; what stays here is the route, the clone, and the two live registers
// that make a new bead-space appear without a restart.
import {
  attachBeadRepo,
  carriesBeadsData,
  cloneRepo,
  readSource,
  defaultCloneRoot,
  defaultTrackerRoot,
  initTracker,
  inspect as inspectDir,
  nameProblem,
  pinBeadSpace,
  pinSessionDir,
  prefixesInUse,
  suggestPrefix,
  tilde,
  PREFIX_OK,
} from './newspace.js';
// The level above a space — which of your lives every screen is currently about.
import {
  accountHandles,
  accountRoster,
  accountSpaces,
  accountWorkspaces,
  activeAccount,
  repoInAccount,
  accountFor,
  accountHandle,
  describeAccount,
  inAccount,
  normalizeEmail,
  withAccount,
  withoutAccount,
} from './accounts.js';
import { createEpicFiler, refFor as jiraRefFor } from './jiraepic.js';
import { cancelledTickets, liveResults, liveTickets, strandedCancels } from './jiracancel.js';
import { approveTicket, beadifyTicket, cancelTicketAndEpic, forgetCancel } from './jiragate.js';
import { createIngester } from './jiraingest.js';
import { ticketView } from './jiraview.js';
import { createResolvedSweep } from './jiraresolved.js';
import { createJiraPoller, jiraEveryMs } from './jirapoll.js';
import { createSweep, mergeTrouble, troubledNames } from './sweep.js';
import { createSyncer, syncEnabled, syncEveryMs, syncCeilingMs, describeSync, syncCardVerdict } from './sync.js';
import { createPublisher, describePublication } from './publishsweep.js';
import { createEpicWatch } from './epicdone.js';
import { createStrandWatch } from './rootclose.js';
import { createOrphanWatch, describeOrphan } from './orphancensus.js';
import { drop, rangFor, retain as retainRinging } from './ringing.js';
import { recordAnswer, answeredBefore, answeredAgo, pruneAnswered } from './answered.js';
import { arrivedQuiet, quietArrival, retainQuiet } from './hushed.js';
import { addresseeUpdate, addressedElsewhere, addresseesOf, describeAddressees, meHandles } from './addressee.js';
import { bylineFor, writtenByDaemon } from './byline.js';
import { readAll as readActivity, activityFor, setActivity, clearActivity, pruneActivity } from './activity.js';
import * as presence from './presence.js';
import * as claims from './claims.js';
import * as regions from './regions.js';
import { createBranchBeads } from './claimbead.js';
import { tailnetLine, watchForAddress, WATCH_EVERY_MS } from './tailnet.js';
// The views a repo declares about itself, and the machinery that serves them. See the
// header of lib/repoviews.js for what a manifest is and why it lives in the checkout.
import * as repoviews from './repoviews.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  // The notification sounds, for the audition at /sounds. Without a real type an
  // <audio> is handed application/octet-stream and simply never plays — a silent page
  // on the one screen whose entire job is making a noise.
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
};
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];
// Documents a question might tell you to read before answering.
const DOC_EXT = ['.md', '.markdown', '.txt', '.log', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.pdf'];
const SERVABLE_EXT = new Set([...IMAGE_EXT, ...DOC_EXT]);
/**
 * The documents that can be published to Confluence — a subset of what is servable.
 *
 * A page is made by rendering markdown, so the file has to be prose the renderer can
 * read. A `.pdf` or a `.csv` is perfectly readable in the reader tab and there is
 * nothing sensible to make a page out of, so it is refused with a sentence rather than
 * published as a wall of escaped text.
 */
const PUBLISHABLE_EXT = new Set(['.md', '.markdown', '.txt']);

/** Marks "Adam has replied and is waiting on an agent". */
export const REPLIED_LABEL = 'human-replied';

/**
 * The label that makes a bead a question — what `bd human list` asks for, and what
 * answering one takes back off. Read here by the epic board, which has the whole graph in
 * hand and can therefore say whether a bead in a tree is itself waiting on you without
 * going near the sweep. lib/inmain.js and lib/notinmain.js each spell it for themselves;
 * a third copy of a five-character string is cheaper than an import between three files
 * with no other reason to know about each other.
 */
const HUMAN_LABEL = 'human';

/**
 * The two channels, separated — and this one function is what "separate" means.
 *
 * An agent asking to change what it is arrives as an ordinary `human` bead, because
 * every part of the machinery underneath it — the decision block, the thread, the
 * respond-and-close path — is the same machinery a question uses, and forking that
 * would have been two of everything to maintain for no gain. What is *not* the same
 * is the decision. "Should the chat session be allowed to run git log" is not a question
 * about work; it does not compete with one for priority, it does not belong in the
 * same count, and it must not be the thing that pushes a P0 off the top of a phone
 * screen.
 *
 * So the split happens here, once, at the point the rows are already in hand — and
 * every surface downstream gets two lists rather than one list it has to filter
 * correctly. A surface that forgets to filter shows a constitutional request in the
 * work feed, which is precisely the failure this exists to prevent; a surface that
 * ignores `requests` shows nothing, which is visible.
 *
 * Module scope rather than a closure because it holds no state and because the split
 * is the load-bearing claim of the whole feature — it should be testable without a
 * server to hang it off.
 */
export const splitChannels = (rows) => ({
  questions: rows.filter((q) => !q.foundation),
  requests: rows.filter((q) => q.foundation),
});

// What a bead id may look like before it reaches a command line. Anything that
// takes an id from the request body or query is checked against this first.
const BEAD_ID_RE = /^[a-z][a-z0-9]*-[a-z0-9.]+$/i;

/**
 * How much of the tracker the inbox is asking for.
 *
 * `human` is the default and the original behaviour — questions only — and it is
 * what the poller and the Android app get, so widening the phone's view can never
 * change what gets pushed. `agent` is everything live that is NOT a question, and
 * `both` is the union. The reason this exists: a workspace with no `human` beads
 * read as completely idle, so the Climative space chip said 0 while 54 beads were
 * open in it and five were being worked on.
 */
const SCOPES = new Set(['human', 'both', 'agent']);

/**
 * The longest thing `POST /api/session-say` will type into a session.
 *
 * Generous for anything anyone composes on a phone, and roomy enough for a pasted
 * stack trace, while staying far below the ARG_MAX that would make `osascript` fail
 * with an error about the wrong thing entirely. See the endpoint for why the wording
 * of that failure is what decides this number's existence.
 */
const SAY_MAX = 8000;

// Claimed work first, then blocked, then untouched: `in_progress` is the only one
// of the three where somebody is on it right now.
const STATUS_RANK = { in_progress: 0, blocked: 1, open: 2 };

/**
 * How agent beads sort. Live before stalled before idle, then by priority, then
 * most-recently-touched first — a P0 nobody has looked at in a month is less
 * interesting than a P2 an agent moved ten minutes ago, but only just, so priority
 * still wins over recency.
 */
function byUrgency(a, b) {
  return (
    (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
    (a.priority ?? 9) - (b.priority ?? 9) ||
    String(b.since || '').localeCompare(String(a.since || ''))
  );
}

/**
 * `extra` is for a header that has to travel with the status rather than in the body.
 * bin/router.js's own `json` has taken one since the swap-drain 503, for the same reason:
 * public/report.js decides whether a 5xx is worth a P0 by reading a header off the
 * response, before anything parses what is in it. See the view-data 502 below.
 */
const json = (res, code, obj, extra) => {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    ...extra,
  });
  res.end(buf);
};

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Start a deploy, and say on the log that it started — the only way this file starts one.
 *
 * `settleDeploys` has always emitted a `deploy` event when one *ends*, and for a long
 * time that was the whole of it: nothing anywhere said a deploy had begun. The cost of
 * that landed on the clients. The deploy strip put every other view on the delta stream
 * and then had to keep one wall-clock timer, asking `/api/deploys` every thirty seconds
 * for as long as it was open, purely so that a deploy started somewhere else — the
 * Ship button on another device, an agent's own `POST /api/deploy`, the release queue
 * shipping itself — turned it on. One event here deletes that timer: the page holds a
 * socket, asks for nothing, and switches to its fast clock in the moment something
 * begins shipping. (The strip was on `public/prs.js` when this was written and is
 * `public/releases.js` since bc-khoe.7; the clock did not move with it.)
 *
 * **One event type, not two.** The record's own `status` is what tells the two halves
 * apart, and it already rides both: `queued` here, and a settled word — `ok`, `failed`,
 * `unconfirmed`, `lost` — when `settleDeploys` emits the other one. A client that knows
 * which statuses a runner still owns (`LIVE` in lib/deploy.js, mirrored in
 * public/prs.js) reads "started" off the event without a second request, and a client
 * that does not simply goes and asks — which is what every consumer of this event did
 * before it existed anyway. A second `type` would have needed adding to `BOARD_EVENTS`
 * in public/stream.js and to every other list of event names, in exchange for a fact
 * already in the payload.
 *
 * **The emit is after the record and before the reply, deliberately.** On this repo a
 * deploy SIGKILLs this process a grace period from now, so the last useful thing the
 * daemon can do is tell every parked poll before it goes; and `startDeploy` throws for a
 * repo that declares nothing or that already has one running, which is a deploy that did
 * not start and must not be announced as one.
 */
function beginDeploy(bus, cfg, key, opts) {
  const rec = startDeploy(cfg, key, opts);
  bus.emit({
    type: 'deploy',
    // Both, for the same reason the record carries both: `key` is what a board card matches
    // itself against, and `workspace` is what a client filtering by space or tracker reads.
    key: rec.key,
    workspace: rec.workspace,
    repo: rec.repo || null,
    id: rec.id,
    status: rec.status,
    bead: rec.bead || null,
  });
  return rec;
}

async function readBody(req, limit = 1024 * 512) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/**
 * Is this one key worth filling right now? bc-1kwl.4's whole gate, in one place.
 *
 * **Per key and per workspace, not per screen**, and that is the correction worth
 * naming: a gate that answered for a whole fan-out — "some workspace moved, so warm the
 * foundation channel" — would fill *every* workspace's key, because these windows are
 * ten seconds wide and by the time a pass runs they are all past it. One repo being
 * written to would then re-sweep nine, six times a minute, which is the load this gate
 * exists to prevent wearing the shape of the thing that prevents it.
 *
 * **Cold is unconditional, and staleness on its own is never a reason.** A key with
 * nothing kept is the only thing that can make a request wait, so it is warmed whatever
 * the clock says. A key that *has* something kept is warmed only when its own tracker
 * has moved since — because `bd` is the only source these have, so a manifest that has
 * not moved (lib/detect.js) means a fresh sweep would return the same bytes. Re-asking
 * anyway is the interval warmer bc-1kwl.5's acceptance forbids: daemon load with
 * nothing moving does not rise.
 *
 * `floorMs` is the other half of that, for the opposite day: on a Mac with twenty agent
 * sessions writing, *something* has moved on nearly every five-second beat, and without
 * a floor "warm what changed" is "warm everything, six times a minute". A key filled
 * inside the floor is left alone however much moved.
 *
 * `peek` is injected for the suite, which is the only way to assert this without a
 * tracker: the interesting cases are all about what is kept and how old it is.
 */
export function warmDue(key, ws, { changed = new Set(), now = Date.now(), floorMs = 30_000, peek = cachePeek } = {}) {
  const kept = peek(key);
  if (!kept) return true;
  return changed.has(ws) && now - kept.at >= floorMs;
}

export function createApp(cfg) {
  // The threshold the slow log fires at, and the only knob timing has. The counting
  // itself is never configurable: instrumentation you have to switch on is off for
  // every complaint you did not anticipate. See lib/timing.js.
  timing.configure({ slowMs: cfg.slowRequestMs });
  const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });
  const workspaces = new Map(cfg.workspaces.map((w) => [w.name, w]));

  /**
   * The workspaces a client may be shown right now — every one on the Mac, narrowed to
   * the active account (lib/accounts.js).
   *
   * **Every payload that hands a client a list of workspace names goes through here, and
   * nothing else does.** The sweeps, the poller, the advocates and every path that acts
   * on a named workspace keep reading `workspaces` itself: an account is what you are
   * looking at, not what this daemon is doing, and a scope that reached into the sweep
   * would mean switching account started the sweeping again from nothing. It also means
   * the narrowing cannot be mistaken for a permission — a caller holding the token can
   * still name any workspace on any route, exactly as it could before, which is what
   * keeps ntfy's action buttons and the Android app working with no account anywhere in
   * them. See the header of lib/accounts.js.
   *
   * Identical to `[...workspaces.keys()]` on an install with no accounts configured.
   */
  const scopedWorkspaceNames = (state = loadState()) =>
    accountWorkspaces(activeAccount(cfg, state), [...workspaces.keys()]);

  /**
   * The same narrowing, as the `{name, dir}` records the on-demand sweeps take.
   *
   * `scopedWorkspaceNames` above is for a payload; this is for a sweep that is about to
   * ask `bd` a question per workspace — the work board, the endorsement queue, the bead
   * ledger. Those are swept *because a screen was opened*, so narrowing the input is both
   * the scoping and a saving: an account of two repos does not wait on eight.
   *
   * The poller's own sweeps deliberately do **not** go through here. They keep reading
   * every workspace, because a bead in the account you are not in still has to be filed,
   * counted and ready the moment you switch — see the block in `inboxPayload`.
   */
  const scopedWorkspaces = (state = loadState()) => {
    const account = activeAccount(cfg, state);
    return (cfg.workspaces || []).filter((w) => inAccount(account, w.name));
  };

  /**
   * One advocate per repo, narrowed the same way — the console's rows.
   *
   * Narrowed rather than paused: the advocates in the account you are not in go on
   * running, surveying and opening sessions, because an account is what you are looking
   * at and not what this Mac is doing. Pausing them on a switch would make "which of my
   * lives am I in" a switch that stops work, which is a much larger promise than the
   * chip in the top bar is making.
   */
  const scopedAdvocates = (state = loadState()) => {
    const account = activeAccount(cfg, state);
    return advocates.snapshot().filter((a) => inAccount(account, a.workspace));
  };

  /**
   * The approved checkouts of every workspace that has more than one, keyed by workspace
   * — what the add-an-account form asks its second question from.
   *
   * Read straight off `cfg.repos.<ws>.approved` rather than through `repoList`, which
   * resolves each entry to a directory and reads a service token out of it. This is a
   * form's list of names: it must not touch the disk, and it must not go quiet about a
   * checkout that happens to be unmounted this morning. An entry written as a path is
   * shown by its last segment, which is the name `repoList` would give it too.
   */
  const approvedRepos = () =>
    Object.fromEntries(
      [...workspaces.keys()]
        .map((name) => [
          name,
          (reposBlock(cfg, name)?.approved || [])
            .map((e) => String(e || '').trim())
            .filter(Boolean)
            .map((e) => e.split('/').filter(Boolean).pop()),
        ])
        .filter(([, list]) => list.length > 1)
    );
  const assetRoots = (cfg.assetRoots || []).map((r) => path.resolve(r));
  // Filled in by startPoller so a write here can update its comment baseline.
  const hooks = {};
  // What /api/poll parks on. The PWA ignores it and keeps re-polling; the Android
  // watch service lives on it.
  const bus = createEventBus();
  /**
   * The session audit agent — bc-dgx7.1, and the one agent here that work does not start.
   *
   * It is handed to the advocates rather than ticked, because its trigger is a session's
   * archive landing and that happens inside the advocate's own archive loop. Everything
   * it needs to decide whether a run is worth starting is in the ledger it keeps, so
   * there is nothing here to hold and nothing to lose across a restart.
   *
   * `onSettled` is why it takes a callback at all: a run outlives the tick that started
   * it by minutes, so the candidates it files reach the endorsement queue long after
   * whatever sweep was running has returned. They arrive held, which is why the queue's
   * cache is dropped — the same reason the JIRA ingester drops it one screen along.
   */
  const auditor = createAuditor({
    cfg,
    bd,
    onSettled: (out) => {
      if (!out?.filed?.length && !out?.misses?.length) return;
      bus.emit({
        type: 'audit',
        key: out.workspace,
        workspace: out.workspace,
        detail: out.filed.length
          ? `${out.sessions.length} session(s) audited — ${out.filed.length} skill candidate(s) filed`
          : `${out.sessions.length} session(s) audited — ${out.misses.length} miss(es)`,
      });
      if (out.filed.length) forgetQueue();
    },
  });

  // One agent per repo, driving its queue to zero — see lib/advocate.js. It is
  // ticked by the poller rather than by a clock of its own: a bead becoming ready
  // is an event the daemon is already looking for every 30 seconds.
  const advocates = createAdvocates(cfg, { bd, bus, audit: auditor });

  // The two halves of one window budget, tied together here because this is the only
  // place that holds both (bc-29b3). lib/advocate.js already subtracts live resolvers
  // from its own free slots by importing the registry; the registry cannot import back
  // without a cycle, so the daemon hands it a function instead — asked at the moment a
  // sweep wants a window, not read once, because `globalMaxWorkers` is a console stepper
  // and the worker count moves every tick. Without this line the yielding is one-way: a
  // Mac full of workers would still take two more windows for a sweep.
  setMaxLive(cfg.advocates?.maxResolvers);
  accountAgainst(() => {
    const g = advocates.globals();
    return { live: g.live, cap: g.maxWorkers };
  });

  // Which bead a claimed file's branch belongs to — asked of `bd` once per branch, never
  // on the claim itself. See lib/claimbead.js for why the hook cannot do this and why the
  // answer arrives after the claim it belongs to.
  const branchBeads = createBranchBeads({ cfg, bd, attribute: claims.attribute });

  // A token file pointed inside the config repo at a name its denylist does not refuse
  // — the hole `secretFileWarning` covers for the Google client secret, said here for
  // the two Atlassian tokens. Once, at boot, rather than on the request that would find
  // out: this is a fact about the file on disk, and a line per publish is a line nobody
  // reads. Nothing is switched off over it — refusing would turn a working integration
  // off over a filename — so this line is the only tell there is (bc-jv4p).
  for (const risk of [confluenceTokenWarning(cfg), ...cfg.workspaces.map((w) => jiraTokenWarning(cfg, w.name))]) {
    if (risk) console.warn(`[atlassian] ${risk}`);
  }

  /**
   * The global pause, over the two subsystems it composes — see lib/admin.js.
   *
   * `suspend`/`resume` rather than close/open: a paused terminal keeps its
   * conversation and comes back as itself. `open` is the fallback for a record that
   * is no longer there, and it is handed in from here rather than imported so a
   * replacement is seeded with the same brief `POST /api/terminal` writes.
   */
  const admin = createAdmin(cfg, {
    advocates,
    terminals: {
      list: listTerminals,
      suspend: suspendTerminal,
      resume: (id) => {
        const t = getTerminal(id);
        if (!t || t.status !== 'resumable') return false;
        resumeTerminal(cfg, t);
        return true;
      },
      open: (record) => {
        const ws = requireWorkspace(record.workspace);
        return openTerminal(cfg, ws, {
          bead: record.bead || null,
          prompt: terminalPrompt(ws.name, record.bead?.id || null, record.bead?.title || ''),
          cols: record.cols,
          rows: record.rows,
        });
      },
    },
  });

  /**
   * Agents whose configured tools override is armed for their **next reply**.
   *
   * In memory, and that is the design rather than an omission. Elevation that
   * survives a restart is elevation nobody remembers granting: this set is emptied
   * by sending the comment it was armed for, and by the daemon stopping. The tools
   * themselves are never here — they come from the config file, and arming decides
   * only whether that string is used for one run.
   */
  const armedTools = new Set();

  const rosterNow = () => publicRoster(cfg, { armed: armedTools, busy: busyAgents() });

  /**
   * The conversation list the launcher draws, with the agent chats named.
   *
   * Two routes hand this list back — reading it, and closing a row — and they have
   * to agree: a close that returned the undecorated list would repaint every agent
   * chat as an ordinary chat session until the next reload.
   */
  const consoleList = () => withAgentNames(listConsoles(), cfg);

  /**
   * The same list, narrowed to the account — what the launcher and the inbox draw.
   *
   * A conversation started outside every repo keeps its place in both accounts, which is
   * `inAccount`'s rule for a row that names no workspace and is argued there: an account
   * has no **All** to widen back to, so a row hidden by every one of them is a row that
   * is gone.
   */
  const scopedConsoles = (state = loadState()) => {
    const account = activeAccount(cfg, state);
    return consoleList().filter((c) => inAccount(account, c.workspace));
  };

  // Keyed by the console record itself, so it neither reaches the file the console is
  // persisted to nor outlives one that was closed and pruned. A record re-read from
  // disk is a new object and gets one honest lookup, which is right — the tracker has
  // certainly moved since a daemon restart.
  const flaggedTitles = new WeakMap();

  /**
   * Does this draft propose a bead that is already filed?
   *
   * `POST /api/console/create` is the only write in the whole console, and until
   * bc-pzti it was the only path into the tracker that never asked. The other three
   * all do — lib/advocate.js flags a proposal as it is written, `/api/respond`
   * re-checks and *refuses* one nobody was shown, and bin/file.js checks what a
   * session files mid-work — and lib/dupe.js was simply never imported by
   * lib/draft.js. What that cost is measured: bc-qsj6 (15:14:49), bc-nib3 (15:23:15,
   * eight minutes later, independently worded) and bc-xpwh (16:37:13, word for word)
   * are three epics for one history page, filed from three chats in 82 minutes, and
   * the third of them reached a finished, unmergeable branch writing the same two
   * filenames as the second.
   *
   * **It warns, it does not refuse**, which is the decision on bc-x3e9 and the one
   * place this differs from the approval path. A proposal card is a question answered
   * by one tap, so a duplicate nobody was shown is not something that tap consented
   * to. A chat session is the opposite: you are looking at the cards, you edited them
   * over several turns, and re-filing something on purpose is a real thing to want.
   * So the warning is on the card in the same words the proposal card uses, the
   * button still says **Create**, and nothing here can lose a draft — a lookup that
   * fails leaves the cards exactly as they were, unflagged, which is what every draft
   * was before this existed.
   *
   * **Only the titles decide whether it asks the tracker at all.** This runs on every
   * save, and the phone saves the cards 700ms after you stop typing — so a sweep per
   * save would be a `bd` subprocess for every sentence of a description, which is the
   * bulk of what editing a draft actually is. `findDuplicate` reads nothing but the
   * title, so a draft whose titles have not moved cannot have a different answer, and
   * the verdicts already on the cards are carried forward instead. No clock in it: a
   * cache with a TTL would make the same saving and make what the daemon does depend
   * on how fast you type.
   */
  const flagDraftDuplicates = async (ws, draft, c = null) => {
    if (!draft?.beads?.length) return draft;
    const titles = draft.beads.map((b) => b.title);
    const withNote = (beads) =>
      beads.map((b) =>
        b.duplicate?.id ? { ...b, duplicate: { ...b.duplicate, note: dupeNote(b.duplicate) } } : { ...b, duplicate: null }
      );

    if (c && JSON.stringify(flaggedTitles.get(c)) === JSON.stringify(titles)) {
      // The same titles, already answered. `normalizeDraft` has just dropped the
      // verdicts — the editor never sets one — so they are put back from the stored
      // draft rather than re-derived, by ref, which is what the phone edits by.
      const prior = new Map((c.draft?.beads || []).map((b) => [b.ref, b.duplicate || null]));
      return { ...draft, beads: withNote(draft.beads.map((b) => ({ ...b, duplicate: prior.get(b.ref) || null }))) };
    }

    let live = [];
    try {
      const rows = await bd.listStatus(ws, 'open,in_progress,blocked');
      // `pending: true` — a proposal still waiting on you asks for beads that do not
      // exist yet, and drafting one of them by hand is the same collision a day early.
      // The approval path passes `false` for the opposite reason: it is deciding
      // whether to *refuse* a create, and nothing a pending card asks for is real yet.
      live = liveCandidates(rows, { proposalLabel: PROPOSAL_LABEL });
    } catch (err) {
      // Logged and dropped. A draft is the output of a conversation, and losing one to
      // a `bd list` that failed would cost far more than the warning is worth — an
      // unflagged draft is exactly what every draft was before bc-pzti.
      console.error(`[beadcause] console: drafting without a duplicate check — ${err.message.split('\n')[0]}`);
      return draft;
    }
    if (c) flaggedTitles.set(c, titles);
    // `note` is written here, not on the phone, so the sentence on a draft card and
    // the sentence on a proposal card are the same sentence rather than two copies of
    // it that drift.
    return { ...draft, beads: withNote(annotateDuplicates(draft.beads, live)) };
  };

  /**
   * The same conversations, as rows for the inbox.
   *
   * Chat stopped being a tab (bc-l8jp.5), so the conversations you have open are in
   * the inbox now, under a filter category of their own — which means they ride the
   * payload the inbox already waits for rather than a second fetch. A second round
   * trip would paint the questions first and drop the chats in underneath them a
   * moment later, on the one screen where a list settling under your thumb is the
   * thing being complained about.
   *
   * Two differences from the launcher's list, and both are about what an inbox is:
   *
   * - **Open ones only.** A closed conversation is a thing you finished; the
   *   launcher keeps them so you can read one back, and an inbox that carried thirty
   *   of them would be an archive with today's work somewhere inside it.
   * - **Stamped with the space.** The inbox filters by space before anything else,
   *   and it reads `q.space` to do it (`spaceOf`) — the same field `matchesFilter`
   *   reads on the server. A row without one answers to "Other" and would vanish the
   *   moment a space was picked.
   */
  const inboxConsoles = () =>
    scopedConsoles()
      .filter((c) => !c.closedAt)
      .map((c) => ({ ...c, space: spaceFor(cfg, c.workspace)?.name || null }));

  /**
   * How many advocates are waiting on you to answer a proposal.
   *
   * Held here rather than recomputed per request, because the number has to mean the
   * same thing in every scope. The bar that draws it sits above the inbox whichever
   * channel you are reading, and the `agent` scope deliberately runs no `human` sweep
   * at all — so counting the rows of the response would make the badge disappear when
   * you switch tabs, which reads as "answered" rather than as "not fetched".
   *
   * Every sweep updates it, including the poller's, which runs every thirty seconds
   * whatever any client asked for. So the worst it is ever stale by is one poll, and
   * nothing here costs a `bd` call it was not already making.
   */
  let proposalsPending = 0;

  /**
   * The spaces as the last sweep saw them — what the space picker in the top bar
   * draws, on every page rather than only on the inbox.
   *
   * Cached from the last sweep for a reason `proposalsPending` does not have: the
   * picker is on the PR board, the advocate console and the chat launcher too, and
   * none of those sweeps the tracker for questions. Recomputing it per request would
   * put `bd human list` across every workspace behind a control that is drawn on
   * every page load, which is the one cost this app is careful never to pay twice —
   * so /api/spaces serves this, and is a JSON read of one variable.
   *
   * The `count` on each row is a leftover of the sweep that builds it and nothing
   * draws it: the picker carries no numbers at all since bc-ka5y.1. What is read is
   * the shape — which repos are in which space, and which spaces are quiet.
   *
   * Worst case it is one poll stale (thirty seconds), which is the same staleness the
   * inbox's own badges already accept.
   *
   * **Not on lib/cache.js, and it cannot be until the inbox itself is** (bc-1kwl.7).
   * bc-1kwl.3 listed this with the four hand-rolled caches it converted, and it is not
   * one: there is no `{ at, value }` here and no producer. It is a snapshot that
   * `allQuestions()` *writes* on its way past, and lib/cache.js is a read layer — its one
   * entry point takes a producer and runs it, and the only way to put this on it is to
   * give /api/spaces a producer that sweeps. That producer is `bd human list` across every
   * workspace, behind a control drawn on every page of the app, which is the exact cost
   * the paragraph above exists to refuse. Nor would the layer buy anything it does not
   * already have: a cold read here is `summarise(cfg, [])` and not a wait, and nothing
   * needs to drop it by name.
   *
   * What makes it convertible is bc-1kwl.7, which puts `allQuestions()` itself on the
   * layer under a key per workspace. Once the sweep is a cache entry, this stops being a
   * variable somebody remembered to update and becomes a read of that entry — and the
   * mutation below — the space-settings write, where toggling 🔕 patches this row so the
   * bar does not disagree with the control you just pressed — becomes a drop rather than a
   * `map`. Doing half of that now would mean writing the wrong half.
   */
  let spacesPending = [];

  /**
   * When the tracker was last actually read — the daemon's own half of "is this list
   * current" (bc-lmdv).
   *
   * A client can tell that *it* has not heard from this daemon: its poll is failing and
   * its own clock says how long for. What it cannot tell from the outside is the other
   * silence — a daemon that answers every poll immediately and has not swept `bd` since
   * breakfast, because its sweep is wedged on a Dolt lock or its interval was configured
   * in hours. Both look identical from the phone: a quiet list. So the age of the last
   * real read rides on the payload, and public/freshness.js draws whichever of the two
   * silences is happening.
   *
   * Stamped in `allQuestions` rather than in the poller, because that is the function
   * that reads the tracker whoever called it — the poll tick, a cold inbox, a resync —
   * and "when did anything last look" is the question a stale screen is asking.
   *
   * Null until the first sweep lands, which the banner reads as "starting up" rather
   * than as an infinitely old list.
   */
  let sweptAt = null;

  /**
   * Which repos did not answer the last time we asked, per channel — see lib/sweep.js.
   *
   * Three records rather than one because the three sweeps ask `bd` different
   * questions, and a repo can answer `human list` and fail `list --status=open` in
   * the same second. Each holds that channel's last good rows for the workspace, and
   * a sweep that throws returns those instead of an empty list — so a lock collision
   * costs the list its freshness rather than its contents.
   */
  const sweeps = {
    questions: createSweep('questions'),
    beads: createSweep('beads'),
    foundation: createSweep('foundation'),
  };

  /**
   * Whether each workspace's tracker still agrees with the machine it shares one with —
   * see lib/sync.js. Ticked by the poller on a clock of its own, read here, because
   * what it holds has to reach the same payload the trouble list rides.
   *
   * `initial`/`save` are what stop a restart re-announcing an outage that never
   * stopped (bc-y3qk.7): `state.json`'s `sync` key already has a commit-on-change
   * history through `saveState` (lib/commonrepo.js), so this costs nothing new to keep
   * — the read is one `loadState()` at boot and the write is the same read-modify-write
   * every other field in that file already gets.
   */
  const syncer = createSyncer({ bd, initial: loadState().sync, save: (rows) => saveState({ sync: rows }) });

  /**
   * The compliance publication sweep — see lib/publishsweep.js.
   *
   * Built here rather than inside the poller for the syncer's reason: it holds the clock
   * that says when it last ran, so it has to be built once and swept rather than made
   * afresh on each beat. Built unconditionally, and that costs an install with the
   * management system off exactly nothing — the constructor reads no state, and the
   * sweep's whole body is behind `whenOn`.
   *
   * No transport, because there is no service to send to yet (bc-3muu.14). The chain is
   * still kept, which is the arrangement lib/publication.js argues for at length: the
   * local chain is the record and the service corroborates it, so an install with nowhere
   * to publish is behind rather than silent.
   */
  const publisher = createPublisher();

  /**
   * Which epics were open the last time the poller looked — see lib/epicdone.js.
   *
   * Beside the syncer above and for its reason: it is the only other thing in this app
   * whose whole content is a comparison against what it last saw, so it has to be built
   * once and ticked, rather than asked from a handler that would have no history to
   * compare against.
   */
  const epicWatch = createEpicWatch({ bd });

  /**
   * What this daemon has already said about a root closing over open work — lib/rootclose.js.
   *
   * Beside `epicWatch` because it watches the same event and reads the same cached graph,
   * and built once for the same reason the others here are: its whole content is what it
   * has already done, and a handler rebuilt per request would have none of it.
   */
  const strandWatch = createStrandWatch({ bd });

  /**
   * The ordinary orphans this daemon has already told the log about — bc-xl7n.83 and
   * lib/orphancensus.js. Beside `epicWatch` for the same reason: its whole content is a
   * comparison against what the last pass saw, so it is built once and ticked.
   */
  const orphanWatch = createOrphanWatch({ bd });

  /**
   * What JIRA says is assigned to you, per workspace — see lib/jirapoll.js.
   *
   * On a clock of its own inside the cycle, like the syncer above, and for the same two
   * reasons: it is a network call rather than a tracker read, and it is about a question
   * nobody is watching a second hand for. A workspace with no `jira` block never reaches
   * the network at all, which on this machine is every workspace until somebody types
   * one in.
   */
  const jira = createJiraPoller({ bd });

  /**
   * And the bead each of those tickets gets — one P1 epic, held, forever — see
   * lib/jiraepic.js.
   *
   * Beside the poller rather than inside it, because they fail in different directions
   * and only one of them may be retried freely: a JIRA read that fails costs a record and
   * the last good answer, where a `bd create` that half-succeeded costs a duplicate bead
   * nobody asked for. Keeping the filing out of `sweep()` is also what lets it be skipped
   * for a workspace whose read failed, which is the whole of its cheap path.
   */
  const jiraEpics = createEpicFiler({ bd });

  /**
   * And what happens when one of those tickets is **resolved** — see lib/jiraresolved.js.
   *
   * The other side of the filer, and it needs both of the two above to say anything at
   * all: the poller's answer is what a ticket has vanished *from*, and the filer's map is
   * what says which epic the vanished ticket had. Neither of them can hold this on its
   * own, which is why it is a third object here rather than a branch inside either.
   */
  const jiraResolved = createResolvedSweep({ bd });

  /**
   * And the children under each of those epics — see lib/jiraingest.js.
   *
   * The third of the three, and the only one that runs an agent: it reads the ticket's
   * own description and thread and creates the beads it decomposes into, held, under the
   * epic. Minutes per ticket, so `sweep` starts runs and never awaits one — a poll cycle
   * that blocked on a `claude -p` would stop the phone being answered.
   *
   * `onSettled` is why it takes a callback at all. A run outlives by minutes the sweep
   * that started it, so the wake for a phone parked on `/api/poll` cannot come from the
   * sweep's return value; the row's answer changes when the run ends, and that is when
   * the event has to be emitted. One per ticket that settles, which is a handful a day —
   * not per tick, which would wake every parked client every minute to redraw an
   * identical inbox.
   */
  const jiraIngest = createIngester({
    bd,
    onSettled: (out) => {
      if (!out?.workspace) return;
      bus.emit({
        type: 'jira',
        key: out.workspace,
        workspace: out.workspace,
        state: out.state,
        detail:
          out.state === 'done'
            ? `${out.key} ingested into ${out.children} bead(s) under ${out.epic}`
            : `${out.key} could not be ingested — ${out.error}`,
      });
      // The endorsement queue's fifteen-second cache is the one screen these arrive on,
      // and they arrive held — the same reason the epic filer drops it.
      forgetQueue();
    },
  });

  /**
   * Every repo currently in trouble, in one list, for the payloads that carry it.
   *
   * Read on the way out of a sweep rather than stored: a repo that answered this time
   * is not in trouble any more, and the whole point is that the screen stops saying so
   * the moment it is true again.
   *
   * **Only the channels this response actually swept.** A record is per channel and is
   * only ever updated by asking, so a `beads` failure from ten minutes ago is still on
   * file for as long as nothing has asked again — and the inbox in the `human` scope
   * never will. Reporting it there would be a banner about a list that is not on
   * screen, which cannot be cleared by anything the person looking at it can do.
   */
  const sweepTrouble = (channels = ['questions', 'beads', 'foundation']) =>
    mergeTrouble(...channels.map((c) => sweeps[c]).filter(Boolean));

  /**
   * The two numbers the inbox's tab bar draws, and neither costs a `bd` call.
   *
   * `liveSessions` is a readdir plus a JSON parse per session file — cheap enough for
   * the poll every client already makes, which is the whole reason these live on
   * /api/questions and the rest of the same picture lives on /api/work. That one is
   * two `bd` calls per workspace, about a second for six, and is opened when you want
   * it rather than every thirty seconds on a phone.
   *
   * There was a third — `questions`, the count behind the top bar's "N waiting" pill.
   * The pill is gone (bc-ka5y.1) and so is the number: nothing drew it, and a served
   * count nobody draws is a count that quietly goes wrong.
   */
  const summaryNow = () => ({
    // Every live session on this Mac, including the ones in no configured workspace —
    // the same set the sessions view lists, because a badge that counts a smaller set
    // than the page it links to is a badge that argues with its own destination.
    sessions: liveSessions(cfg).length,
    proposals: proposalsPending,
  });

  /**
   * That bead's notification is gone — answered, commented on, or set aside.
   *
   * Called beside every `answered` / `commented` emit, because those are exactly the
   * events a shell cancels the row on. Waiting for the poller to notice would leave
   * this daemon believing a row is still in a shade it has already cancelled.
   */
  function unring(key) {
    const state = loadState();
    if (!state.ringing[key]) return;
    saveState({ ringing: drop(state.ringing, [key]) });
  }

  /**
   * The inbox's payload, in one place, because two endpoints have to answer with it.
   *
   * `/api/questions` is what a cold inbox asks for; `/api/poll` is what a warm one
   * parks on. They used to be different shapes — the poll carried the rows, the
   * spaces and nothing else — so a client that refreshed itself from the poll got a
   * list with no counts on the chrome and no filter to obey, and the only way to have
   * those was to throw the poll away and sweep `bd` again.
   * That second sweep is the whole cost this exists to remove: the poll already only
   * wakes when something moved, so what it wakes with has to be everything.
   *
   * Built rather than spread from a constant because several of the fields are reads
   * — `loadState` twice over would be two different states — and because the filter
   * has to be reconciled before the rest of it is built. Both callers get the same
   * one, or the difference is a field that is right on a cold load and missing on
   * every refresh after it, which is the hardest kind of wrong to notice.
   *
   * `channels` is the one thing a caller has to say for itself: which sweeps went into
   * `rows`. It decides whose failures are reported — see `sweepTrouble`.
   */
  /**
   * The epic board — which roots are yours, and which of the rows below descend from one.
   *
   * **The whole feature is off when this Mac does not know who it is.** `cfg.me` unset is
   * every install that has never heard of this, and it answers `{ owned: false }` — which
   * the client reads as "draw the inbox you have always drawn". Not a default that happens
   * to be empty: a branch that cannot be entered, the same guarantee lib/addressee.js and
   * lib/ownership.js make out of the same setting. An install that switched this on and
   * owned nothing yet would otherwise get a screen with every card hidden and no way to
   * tell that from a quiet afternoon.
   *
   * **`under` is computed here and not on the phone**, because ancestry is a `bd export`
   * and a graph walk (lib/ancestry.js) and neither belongs in a service worker. The client
   * gets one string per row — the id of the root it hangs off, or nothing — and filters on
   * that. It also means the answer is the same on the phone, the laptop and the watch.
   *
   * **The board is the roots you have *started*, not the ones you have filed** (bc-6s96).
   * A card is drawn for a root you own whose status is `in_progress`. Closed has never been
   * on it — a root that landed is not something to lead the screen with, and its descendants
   * stop being pulled in with it, which is the intended end of an epic rather than a case
   * to handle — and open-but-not-started is now off it for the same reason from the other
   * end: it has not begun. bc-6s96 counted the board on 2026-08-16 — ~42 owned P0s not
   * closed against 9 in progress — so the old rule drew a backlog and called it the week.
   * You put a root on the board by starting it — from the phone, through the picker ＋ on
   * My Epics opens (`startable` below, and `POST /api/bead/start`), or on the Mac with
   * `bd update <id> --claim`. bc-s8mc is why `startable` exists at all: the one screen that
   * says what the week is about had, until then, no way to change it.
   *
   * **The flat list below follows, and that is a decided consequence rather than a side
   * effect.** The list is narrowed by `under`, which is keyed on `mine` — so a question
   * belonging to a root you have not started leaves the inbox with its card. It is not moved
   * anywhere and it comes back the moment the epic is started; nothing is dispatched under
   * a not-started root anyway. What it must *not* do is come back as `unhomed`, because
   * that map means "nobody's root has this" and would be a lie here — so `anyRoot` below
   * stays every *open* root in the workspace, deliberately wider than `mine`, and a row
   * under a root of yours that has not started is in neither map. Two maps disagreeing on
   * purpose.
   *
   * **And with nothing started the board is empty, which switches the whole section off.**
   * The client draws the flat inbox when `roots` is empty (`isBoarded` in public/app.js) —
   * the same branch a cold daemon takes for a repaint or two. So the screen you get for
   * having started nothing is the inbox this app had before the board existed, not an
   * empty one.
   *
   * **lib/underroot.js is untouched, and the two are supposed to differ now.** Workability
   * still means an *open* root above — the gate is asking "did anybody decide this work
   * should happen", and filing an epic, or raising a P0, is that decision whether or not
   * you have got to it. Narrowing the gate to started roots would stop the advocate on five
   * sixths of the tracker overnight.
   *
   * One `bd export` per workspace, cached for a minute by `Bd.graph`, and it answers all
   * three parts — see the note there for why this is not three commands. **The third is
   * the tree on each card** (bc-rfnr.9.1): every descendant of that root at any depth, not
   * only the ones with a question pending. It comes off the same cached shape in the same
   * pass, so a board of a dozen roots over 800 beads is one inversion of the parent map and
   * one walk per card — no extra `bd`, and nothing built on the request path.
   *
   * **`startable` is the fifth, and it is bc-s8mc** — the P0s of yours that are *not* on
   * the board and could be, so the picker at its foot has something to offer. Built in the
   * same pass over the same beads, out of the branch the card loop already takes when a P0
   * is yours and has not been started: the alternative was a route of its own doing a
   * second `bd export` to answer a question this one had already read the rows for. It
   * carries a count and no tree — see `rootOffer` — because forty candidates each carrying
   * their subtree is the board's heaviest field multiplied by the backlog, on every poll,
   * to draw a list of titles.
   *
   * **`unhomed` is the fourth part, and it is bc-i7tw.** A row is in it when there is no
   * open root above it *at all* — not yours, not anybody's — and the client draws those
   * whatever the board says. Without it, `under` alone decides, and a question filed with
   * no parent is in no root's descendants, so it is drawn on no screen: `/api/ask` (the
   * phone's share target) and `/api/console/create` over a parentless draft both file
   * that way, which is a question you asked from your own phone vanishing from your own
   * inbox with nothing saying so. lib/underroot.js's pill is the *held* half and is loud;
   * this is the invisible half, and a pill on a screen that does not draw the card cannot
   * reach it. It is not the same question as `under`: "which root do I hang off" and "does
   * anybody's root have me" have different answers on a shared graph, and only the second
   * one is the difference between a card you can see and a card nobody can.
   *
   * **Every row of a workspace whose graph could not be read is in it too**, which is the
   * sentence in the `catch` below finally being true: it said such a workspace "hides none
   * of its rows", and until this existed the rows simply had no `under` entry and were
   * hidden by exactly the filter the sentence promised they escaped. Same direction as
   * `Bd.graph` swallowing a failure into an empty shape — no evidence must not mean no
   * question.
   *
   * **`assigned` is the sixth part, and it is the kind pills' own narrowing** (bc-khoe.29).
   * `under` is the *board's* question — which started root of yours draws this row in its
   * tree — and bc-khoe.28 took the board off every pill but My Epics. On Questions, PRs,
   * Chats and All Beads there is no board on the screen at all, so a list narrowed by
   * "what the board is already drawing" is narrowed by a thing that is not there, and its
   * two gates are both wrong from that end: a question on a bead of *yours* that is not a
   * root has never been in `under`, and one under a root you have filed and not started
   * left it with bc-6s96. Neither is `unhomed` either — a root above it is a root — so
   * neither is on Home in any form.
   *
   * So this map answers the other question: **is this bead yours, or under one that is** —
   * at any depth, whatever the status of the bead above it, root or not, started or not.
   * "Yours" is the `owner:<handle>` label (lib/ownership.js), the same fact the board is
   * built on and not bd's `assignee` cell, which the first agent claim overwrites.
   *
   * **Keyed by bead id and not by row**, unlike `under` and `unhomed`, and that is the one
   * shape decision here worth stating. A pull request is a row on this screen, it is keyed
   * `pr:<repo>#<n>`, and what decides it is the beads it *names* — ids of beads that mostly
   * have no inbox row of their own, so a per-row map could not answer for them at all. The
   * key is `<workspace>/<id>`, which for a bead row is exactly its row key, so the client
   * asks one map two ways (`inBead` already keys pull requests like this).
   *
   * Closed beads are in it too: the predicate is about ownership and not about state, a
   * closed bead has no inbox row to draw anyway, and a pull request still open over a bead
   * that has closed is precisely the row you would not want to lose. Measured on this
   * tracker, 2026-08-18: 536 of beadcause's 1679 beads are in the closure, ~15KB on a
   * 590KB payload.
   */
  async function rootBoard(rows) {
    if (!meHandles(cfg).length)
      return { roots: [], startable: [], under: {}, unhomed: {}, assigned: {}, owned: false };
    const cards = [];
    const startable = [];
    const under = {};
    const unhomed = {};
    const assigned = {};
    // A bead row rather than a pull request or a JIRA ticket, which share this list and
    // are keyed by things that are not bead ids (`pr:<repo>#<n>`). `unhomed` is a claim
    // about ancestry and those have none — the client has its own rule for both, and
    // marking them here would quietly override it.
    const isBead = (name, r) => Boolean(r.id) && r.key === `${name}/${r.id}`;
    // Started. Normalised the way lib/underroot.js normalises its own status read, because
    // the two are answering neighbouring questions off the same export and a difference
    // in whitespace or case between them would be a card and a gate disagreeing about
    // one bead — the exact drift that file's comment exists to prevent.
    const started = (b) => String(b?.status || '').trim().toLowerCase() === 'in_progress';
    // One filesystem read for the whole board, for the reason lib/advocate.js reads it
    // once per tick: every card is then matched against the same snapshot of what was
    // running, so two cards cannot disagree about whether a window is up.
    const sessions = liveSessions(cfg);
    for (const [name, ws] of workspaces) {
      let parents;
      let beads;
      try {
        // `wait: false` — never build this on the request path. 7.3s across nine
        // workspaces on an idle Mac; see the measurement on `Bd.graph`.
        ({ parents, beads } = await bd.graph(ws, { wait: false }));
      } catch {
        // `Bd.graph` swallows its own failures and answers an empty shape; this is the
        // belt for anything it could not. A workspace whose shape is unknown contributes
        // no roots and hides none of its rows — which is the safe direction: the inbox
        // over-shows rather than quietly dropping a question nobody would know to look for.
        for (const r of rows) if (r.workspace === name && isBead(name, r)) unhomed[r.key] = true;
        continue;
      }
      // One inversion of the parent map for the whole workspace — see `childrenFrom`. A
      // dozen roots each inverting it themselves is a dozen passes over 800 beads for an
      // index that is the same every time.
      const children = childrenFrom(parents);
      // Yours, as a set of ids — what `under` is matched against below. Separate from
      // `cards` because one is a membership test per row and the other is the screen.
      const mine = new Set();
      // Every bead of yours in this workspace — root or not, started or not, closed or not
      // — which is the seed of `assigned` below. Gathered in the loop that is already
      // reading every bead and asking this exact question of the roots, because a second
      // pass over seventeen hundred records to ask it again of all of them is a pass for
      // nothing. A second pass is still needed to *spend* it (below), because the map
      // iterates in export order and a child can be read before its owner.
      const owners = new Set();
      for (const b of beads.values()) {
        if (ownedByMe(cfg, b)) owners.add(b.id);
        if (!isRoot(b) || !ownedByMe(cfg, b)) continue;
        if (!started(b)) {
          if (offerable(b)) startable.push(rootOffer(name, b, beads, children));
          continue;
        }
        mine.add(b.id);
        cards.push(rootCard(name, b, beads, children, sessions));
      }
      // Every open root in this workspace, whoever owns it — lib/underroot.js's root set,
      // and deliberately a wider one than `mine` above, now in two directions rather than
      // one. The board is `ownedByMe` and `in_progress` because it answers "what am I
      // working on"; `unhomed` is answering "has anybody at all decided where this
      // belongs", and a colleague's epic on a shared graph — or your own root, filed and
      // not yet started — is that decision. That is the gate's own distinction, kept here
      // so the two cannot drift apart. The gap between them is where a row under a
      // not-started root of yours sits: in `under` no longer, and never in `unhomed`, so it
      // leaves the list without being relabelled as a bead nobody has homed (bc-6s96).
      const anyRoot = rootsOf(beads);
      // And the kind pills' map, which is not about the rows at all — see `assigned` in
      // the header. `underAnyOf` answers for the bead *and* for its ancestors, which is
      // what makes a bead of yours with no children in it as well as the tree below one;
      // spelling that as `owners.has(id) || …` here is the second place lib/ancestry.js's
      // comment warns the bead itself goes missing from.
      if (owners.size) {
        for (const id of beads.keys()) if (underAnyOf(parents, id, owners)) assigned[`${name}/${id}`] = true;
      }
      for (const r of rows) {
        if (r.workspace !== name) continue;
        const line = [r.id, ...ancestorsOf(parents, r.id)];
        const root = line.find((id) => mine.has(id));
        if (root) {
          under[r.key] = root;
          continue;
        }
        // Not under one of yours. Is it under anybody's? No — and no root in the workspace
        // at all counts as no, which is where a tracker nobody has filed an epic in lands:
        // the flat list, not an empty screen. (`hasRootAbove` answers *true* on that shape,
        // because it is protecting the dispatch queue from stopping; here the fail-open
        // direction is the other one, so it is not reused.)
        if (isBead(name, r) && !line.some((id) => anyRoot.has(id))) unhomed[r.key] = true;
      }
    }
    // Highest-priority-then-most-open, which is the advocate's order with the tie broken
    // the way a board wants it broken. **The priority term is not decoration since
    // bc-htoy**: this board was every P0 you owned and so was all one priority, leaving
    // "which has the most still open" as the whole of the sort. It is now epics at any
    // priority *and* P0s — a crash the app filed on itself beside a P3 epic — and dropping
    // the urgent one below the big one because the big one has more children left is the
    // board failing at the one thing it is for. A missing priority sorts last rather than
    // first: an unset field is not a claim of urgency.
    const rank = (c) => (Number.isFinite(Number(c?.priority)) ? Number(c.priority) : 99);
    cards.sort(
      (a, b) => rank(a) - rank(b) || b.open - a.open || String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
    );
    // The picker's list in the board's own order, for the reason the board has one: the
    // root with the most still open under it is the one the week is most likely to be
    // about, and a picker that ordered by id would put the epic filed first at the top
    // for ever. It sorts by `rank` first for the same reason the board does — bc-s8mc
    // wrote this line when the picker could only be P0s and the priority term would have
    // been a no-op; since bc-htoy it offers epics at any priority, so leaving it out
    // would bury a P0 crash under a P3 epic with more children. Ties by id and not by
    // date, because `bd export` carries `created_at` as a string this has no reason to
    // parse and a stable order is all a tie needs.
    startable.sort(
      (a, b) => rank(a) - rank(b) || b.open - a.open || String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
    );
    return { roots: cards, startable, under, unhomed, assigned, owned: true };
  }

  /**
   * One root, as the card at the top of the inbox draws it.
   *
   * The counts are of *descendants*, at any depth, not of direct children: an epic whose
   * five children are themselves epics has forty things open under it and "5" would be a
   * number that reads as almost done. Closed ones are excluded from both because the card
   * answers "what is left", and the fraction that would need the total is on the sheet.
   *
   * **`tree` is the card's own contents**, and it is not `under` seen from the other end.
   * `under` is a fact about the *inbox rows*: which root each one hangs off, so the list can
   * be narrowed. It knows nothing about a bead nobody is being asked about, which on this
   * tracker is most of them — bc-rfnr had 16 descendants and one pending question the day
   * this was written. A card that expands into its own tree needs all 16, so the tree is
   * built from the graph rather than from the rows — including `pending`, which says
   * which of them is itself a question. See the note on that line for why it is read off
   * the label and not off the rows the list is drawn from.
   *
   * `waitingOn` is read off the bead's notes and is null until an Epic Advocate has
   * written one (lib/epicadvocate.js). Null rather than a cheerful default on purpose:
   * "not waiting on anything" is a thing only an agent that has looked can say, and the
   * card draws nothing where this is null — so an epic nobody has advocated yet is one
   * line shorter rather than one claim wronger.
   *
   * **`priority` rides the card since bc-htoy**, where before it could not have said
   * anything: every card was a P0. The board is now epics at any priority beside the P0s,
   * so the number is both what `rootBoard` sorts on and what the card has to draw — a
   * screen that shows a P3 epic and a crash the app just filed as the same kind of row is
   * a screen that has stopped ranking anything.
   */
  function rootCard(workspace, bead, beads, children, sessions = []) {
    // The tree is built first and the counts are read off it, rather than the two being
    // separate walks of the same graph. They were, and the failure mode of that is a card
    // saying "9 open" over a tree with eight rows in it — two answers to one question,
    // arriving in the same object, which is the kind of wrong nobody debugs because
    // neither number looks wrong on its own.
    const tree = treeUnder(children, beads, bead.id).map((row) => ({
      ...row,
      // The same `workspace/id` the inbox rows are keyed by, so the client can reach the
      // question for a bead without rebuilding the key in a second place — the client
      // does not know what a workspace name is beyond a string it was handed.
      key: `${workspace}/${row.id}`,
      // Is this bead itself asking you something? One boolean rather than the row, because
      // the row is already in `questions` and sending it twice would mean two copies of an
      // answer's state on one payload.
      //
      // **Off the label rather than off the rows**, which is the one decision in here that
      // could have gone either way. `rows` is what the list below currently draws, and
      // matching it would have kept the two surfaces identical — but that list is
      // scope-dependent (`/api/questions?scope=agent` sweeps no questions at all) and the
      // board is drawn in every scope, so a bead genuinely waiting on you would have said
      // `pending: false` on the screen bc-rfnr.9.7 leaves you with. An open bead carrying
      // `human` *is* the definition of a question here — it is what `bd human list` asks
      // for, and answering one takes the label back off — so this reads it from the same
      // snapshot the rest of the tree came from and cannot disagree with itself.
      pending: String(row.status) !== 'closed' && (beads.get(row.id)?.labels || []).includes(HUMAN_LABEL),
      // Whether a window is on this bead **right now** — bc-rfnr.9.5, and the half of
      // "what happened to it" that no file on disk can answer.
      //
      // `advocateSession` and not a second spelling of it: a live session is matched by
      // `namesBead`, which is the one rule that does not report a worker on `bc-d6yk.1`
      // as the session on `bc-d6yk` — every parent id is a prefix of its children's, and
      // a link built on `includes` opens somebody else's window. The card above uses the
      // identical call for its advocate; this is that fact per row, which is the only
      // grain a bead in a tree has.
      //
      // Free, and that is why it is on the row rather than behind a request. The
      // sessions are already in hand for the card, so this is a `find` over a list of
      // about thirty — where the *archive* is a `git log` per bead and is therefore
      // asked for one bead at a time, once you open one (`/api/session-archive`).
      // No `openedAt`, so this is never `opening`: that state belongs to the launch
      // door on the card, and there is no button here it would be disabling.
      session: advocateSession(sessions, row.id),
      // Where a department relay on this bead has got to — the last step alone. bc-bmry.4,
      // and the reason it is here rather than behind the tap: `dv-vzg` chose to let a
      // relay run through four roles unattended *on condition* that the steps show up on
      // the epic card, and a trail you have to open a bead to see is one you only look at
      // once you already suspect something. `null` on every bead nothing has relayed,
      // which is every bead in every workspace but deluvia's studio.
      //
      // **Off `index.beads` and not parsed here, unlike `pending` beside it.** `indexFrom`
      // blanks `notes` for everything that is not a root — 700 bodies of prose have no
      // business in a minute-long cache — so parsing it on this line would have answered
      // `null` for every row in every tree, for ever, with nothing anywhere saying so. It
      // is parsed where the text still exists, in lib/ancestry.js, and what is kept is the
      // mark rather than the prose.
      //
      // The last entry and not the trail: sixty rows × six entries is a relay's whole
      // history on the poll payload once per descendant per repaint, to draw one line.
      // `/api/bead` carries the rest, for the one bead you tapped.
      relay: beads.get(row.id)?.relay || null,
    }));
    const live = tree.filter((row) => String(row.status) !== 'closed');
    // Asked once and handed to both fields below, so the boolean-shaped `advocate` and the
    // state-shaped `advocacy` beside it cannot disagree about whether a window is up —
    // which is the whole failure `rootCard`'s header describes about its own two counts.
    const session = advocateSession(sessions, bead.id, { openedAt: openedRecently(`${workspace}/${bead.id}`) });
    return {
      key: `${workspace}/${bead.id}`,
      workspace,
      id: bead.id,
      title: bead.title,
      status: bead.status,
      issue_type: bead.issue_type,
      priority: bead.priority ?? null,
      owners: ownersOn(bead),
      open: live.length,
      inFlight: live.filter((row) => String(row.status) === 'in_progress').length,
      waitingOn: waitingOn(bead),
      // Who is on it, if anybody — a pid the card can link to, "opening" for the minute
      // between the launch and the window naming itself, or null. See `advocateSession`.
      //
      // **Kept exactly as it was, and deliberately not replaced.** The client half of
      // bc-r2b5 lands separately, and a card drawn by a phone that has not reloaded its
      // JavaScript still reads this field; swapping it for the object below would have
      // blanked the advocate line on every device until each one refreshed.
      advocate: session,
      // What the daemon actually knows about this epic's advocate — bc-r2b5.1, and the
      // field the card is drawn from once bc-r2b5.2 lands. `advocate` above says only
      // whether a window is running *this second*, which for a re-entrant supervisor is
      // false nearly all the time and reads as the assignment having been lost.
      //
      // Three sources, none of them a new read: the bead this function already has, the
      // sessions snapshot the board took once for every card, and the re-entry sweep's own
      // per-epic record out of advocates.json — when the last window ran and why one is
      // being held right now, in the sweep's own words. See `advocacyOn`.
      //
      // `alreadyAsked` reads three fields and the graph index carries only one of them,
      // `notes` — which is the one lib/finishedepic.js actually writes its ask into, and
      // `indexFrom` carries notes on exactly the roots this function is called for. The
      // other two are for an ask a person moved by hand and are not reachable from here;
      // a missed one draws a card one badge short rather than a wrong claim.
      advocacy: advocacyOn(bead, {
        session,
        record: advocates.advocacy(workspace, bead.id),
        finished: alreadyAsked(bead),
      }),
      // Everything under this root at any depth, closed included, parents before children.
      // See `treeUnder` for the shape and for why it is flat; bc-rfnr.9.2 draws it.
      tree,
    };
  }

  /**
   * May this P0 be *offered* as something to start? bc-s8mc.
   *
   * The picker is a list of taps, and every one of them writes to the shared tracker —
   * so what it must not contain is a bead that something else in this daemon would then
   * refuse to act on. Three of those, and they are the same three an advocate launch
   * turns away, read here off the graph rather than off a `bd show` per candidate:
   *
   *   - **Unendorsed.** Nobody has said this work should happen yet, and the answer to a
   *     bead you have not endorsed is the endorsement queue, not the board.
   *   - **Superseded.** It is the same job as another bead; starting it would put a card
   *     on the screen for work that is being done somewhere else.
   *   - **A crash.** lib/errors.js files every daemon crash at P0 with an owner, so on a
   *     bad week the picker would be a list of stack traces with the two epics you were
   *     looking for somewhere underneath them. A stack trace is not an epic — the same
   *     sentence lib/epicadvocate.js's `wantsAdvocate` makes, and `isCrash` is its rule
   *     rather than a second spelling of it.
   *
   * `open` and nothing else: `blocked` is a P0 waiting on something, and putting it on
   * the board is a claim that this is what the week is about while the tracker says it
   * cannot move. It stays off the picker, and `bd` is still there for the case where you
   * mean it.
   */
  const offerable = (b) =>
    String(b?.status || '').trim().toLowerCase() === 'open' && !isUnendorsed(b) && !isSuperseded(b) && !isCrash(b);

  /**
   * One root as the picker draws it — a card that could be, without the cost of one.
   *
   * The counts are the card's, from the same walk (`treeUnder` over the same inverted
   * parent map), because "12 open" is most of what you choose on: the picker is answering
   * *which of these is the week about*, and an id and a title alone put that decision back
   * on your memory of the tracker.
   *
   * What it deliberately does not carry is `tree`. A started root sends every descendant so
   * the card can expand into it; a candidate expands into nothing, and forty of them each
   * carrying their whole subtree would be the board's heaviest field multiplied by the
   * backlog, on every poll, to draw a list of titles.
   */
  function rootOffer(workspace, bead, beads, children) {
    const live = treeUnder(children, beads, bead.id).filter((row) => String(row.status) !== 'closed');
    return {
      key: `${workspace}/${bead.id}`,
      workspace,
      id: bead.id,
      title: bead.title,
      issue_type: bead.issue_type,
      // Carried since bc-htoy, and the picker's sort is built on it: while this list was
      // P0s the field would have been the same on every row, and it is now the first
      // term of the order as well as what the row draws.
      priority: bead.priority ?? null,
      open: live.length,
    };
  }

  /**
   * Put a P0 on the board, or take it off — the write behind both routes below. bc-s8mc.
   *
   * **One status write and nothing else**, because the board is `in_progress` and nothing
   * else (`rootBoard`). Not a phone-local pin: the same fact then reads the same from `bd
   * list`, from the advocate console, from the other Mac and from every other screen,
   * which is the whole reason this is a tracker write rather than a preference. The cost
   * of that is honest and worth saying — starting an epic here is a real edit to a shared
   * graph, and `Started:` on `bd show` will say so afterwards.
   *
   * **Every refusal is a 409 with a sentence**, because the acceptance criterion for this
   * feature is that a write bd rejects is loud rather than a card that never appears. The
   * shape is `openEpicAdvocateSession`'s and the four reasons overlap on purpose: a bead
   * this daemon would refuse an advocate on is a bead it should not have offered you as
   * something to start, and the picker's own filter (`offerable`) is built from the same
   * three labels. They are checked again here rather than trusted from the client, for
   * the reason every door in this file re-checks: the picker's list is up to a poll old,
   * and a bead somebody closed in between is exactly the tap that would otherwise go
   * through.
   *
   * **`blocked` is refused rather than started.** It is not a status the picker offers, so
   * arriving here with one means the bead moved under a list drawn a moment ago — and the
   * honest answer to "start this" for a bead the tracker says cannot move is the sentence,
   * not a card claiming the week is about it.
   *
   * **Taking one off sets `open` and leaves the assignee alone** — see `Bd.setStatus`, and
   * the neighbouring `Bd.reopen`, which clears it and is deliberately not reused here.
   * Taking an epic off the board is a decision about what leads *your screen*; who is on
   * the work is a different fact and not this tap's to erase. Distinct from pausing an
   * advocate (bc-lco2), which stops dispatch and leaves the epic started — this is the
   * other axis, and the two compose.
   *
   * No `OBSERVING` guard, which is the same call the verdict routes make and the opposite
   * of `POST /api/bead/advocate`'s: opening a window is the daemon acting, and deciding
   * which of your epics leads the screen is you deciding. The bead is the shared record
   * either way, so an observer instance writing it is not a second daemon acting on the
   * work — it is you, on the machine you happen to be holding.
   */
  async function boardMove(body, { on }) {
    const ws = requireWorkspace(body.workspace);
    const id = String(body.id || '').trim();
    if (!BEAD_ID_RE.test(id)) throw Object.assign(new Error('not a bead id'), { status: 400 });
    // A `bd show`, not the cached graph: the graph is up to a minute old and this is the
    // read a write is about to be made on. 404 for an id that is gone, from `loadBead`.
    const bead = await loadBead(bd, ws, id);
    const status = String(bead.status || '').trim().toLowerCase();
    const refuse = (why) => {
      throw Object.assign(new Error(why), { status: 409 });
    };
    if (!isRoot(bead)) refuse(`${id} is not an epic or a P0 — the board is the roots you own`);
    if (!ownedByMe(cfg, bead)) refuse(`${id} carries nobody's owner: label for you — it is not yours to put on the board`);
    if (status === 'closed') refuse(`${id} is closed — a root that landed does not lead the screen`);
    if (on) {
      if (status === 'in_progress') refuse(`${id} is already on the board`);
      if (status !== 'open') refuse(`${id} is ${status}, not open — start it in bd if you mean it`);
      if (isUnendorsed(bead)) refuse(`${id} is unendorsed — endorse it first`);
      if (isSuperseded(bead)) refuse(`${id} is superseded — the work is somewhere else`);
      if (isCrash(bead)) refuse(`${id} is a crash this app filed, not an epic`);
    } else if (status !== 'in_progress') {
      refuse(`${id} is ${status}, so it is not on the board`);
    }
    await bd.setStatus(ws, id, on ? 'in_progress' : 'open');
    console.log(`[beadcause] ${on ? 'started' : 'un-started'} ${ws.name}/${id} from the root board`);
    // What this changed is the board, on every device holding one — the parked log request
    // is what carries it, and the next payload it answers with is built from the graph
    // `setStatus` has just refreshed. Its own type rather than `advocate`, which is in
    // public/stream.js's `BOARD_EVENTS` and would send every inbox to re-fetch the *pull
    // request* board for a change that touched no pull request.
    bus.emit({ type: 'p0board', key: `${ws.name}/${id}`, workspace: ws.name, id, started: on });
    return { workspace: ws.name, id, started: on, status: on ? 'in_progress' : 'open' };
  }

  async function inboxPayload(allRows, requests, channels = ['questions', 'beads', 'foundation']) {
    // The JIRA read merged in with the `bd` ones, because it is the same claim they make
    // — *this list is missing things* — and a client that has never heard of JIRA then
    // draws the failure in the banner it already has, rather than drawing nothing about
    // a section that is quietly empty. Its own field below carries the unmerged record,
    // for the one thing merging costs: `mergeTrouble` keeps a single row per workspace,
    // so a Dolt lock arriving a second later would otherwise hide an expired token
    // behind a failure that clears itself on the next sweep.
    const trouble = mergeTrouble(...channels.map((c) => sweeps[c]).filter(Boolean), jira);
    const savedState = loadState();
    /**
     * Which of your lives this screen is about — the level above the space, and the
     * first thing applied to everything below it. See lib/accounts.js.
     *
     * **The scoping is here rather than in the sweep, and that is the whole design.**
     * The poller still reads every workspace on the Mac: a bead in the account you are
     * not in has to be swept, filed and counted, so that switching account shows it
     * rather than starting a fresh sweep and showing an empty screen for a second. What
     * an account changes is what is *handed to a client*, which is exactly one function
     * — this one — plus the four other payloads that name workspaces.
     *
     * `null` when no accounts are configured, and every predicate over null answers
     * "in scope", so an install that has never opened the picker gets byte-for-byte the
     * payload it got before this existed.
     */
    const account = activeAccount(cfg, savedState);
    const names = accountWorkspaces(account, [...workspaces.keys()]);
    const mine = (row) => inAccount(account, row?.workspace);
    const rows = allRows.filter(mine);
    // Summarised over the scoped rows and then trimmed to the scoped workspaces, in that
    // order and not the other way round: the synthetic "Other" group is built out of the
    // rows, so a stray repo in the other account would otherwise arrive in a group that
    // `accountSpaces` has no name to remove it by.
    const spaces = accountSpaces(account, summarise(cfg, rows, troubledNames(trouble)));
    const filter = reconcileFilter(spaces, names, savedState.filter);
    // Everything JIRA last said was assigned to you, cancelled ones included — asked for
    // once and split two ways below, because the cancel filter is a `state.json` read and
    // doing it twice on a payload every parked phone rebuilds is the shape that turns a
    // free thing costly (lib/jiracancel.js says the same about itself).
    const held = jira.tickets();
    /**
     * One ticket, stamped with the three things the poller cannot know.
     *
     * `space` because the inbox filters on it before it looks at anything else; `ingest`
     * because the poller knows what JIRA said and nothing about what beadcause did with
     * it; `bead`/`held` off the filer's in-memory map, which has the epic's id from the
     * minute it is filed and long before `ingest.epic` does. Named rather than inlined
     * since bc-0i27.6, because the cancelled half is drawn by the same view and a second
     * copy of this would be the two of them disagreeing about one ticket.
     */
    const stampTicket = (t) => {
      const epic = jiraEpics.epicFor?.(t.workspace, t.key) || null;
      return {
        ...t,
        space: spaceFor(cfg, t.workspace)?.name || null,
        ingest: jiraIngest.stateFor(t.workspace, t.key),
        bead: epic?.id || null,
        held: epic ? epic.held : null,
      };
    };
    return {
      questions: rows,
      /**
       * The foundation channel, and deliberately the one list here that an account does
       * not narrow.
       *
       * It is the same exemption the inbox filter has had since bc-8on, and it is kept
       * for the reason that one is: this pane is drawn above the list and outside every
       * scope on the page, and `quietReasonFor` will not silence a request either. Those
       * two have to agree — a request hidden here but allowed to ring would be a
       * notification with nothing behind it, and one shown here but silenced there would
       * be the reverse. An agent asking to change what it is has no answer to "which of
       * your lives is this about"; it is the same session whichever repo it was in.
       */
      requests,
      workspaces: names,
      spaces,
      /**
       * Who you are being right now, and who else you could be — the top bar draws both
       * (public/accountbar.js). `account` is null on an install with none configured,
       * which is what makes the chip draw `me[0]` and the picker offer to add the first.
       */
      account: account?.email || null,
      accounts: accountRoster(cfg, savedState, [...workspaces.keys()]),
      // The repos this sweep could not read, named, with what `bd` said — see
      // lib/sweep.js. Its own field and empty almost always, so a client that has
      // never heard of it draws the inbox exactly as it did; and on the day it is not
      // empty, the alternative is a list that is quietly missing a repo and an empty
      // state claiming there is nothing to answer.
      trouble: trouble.filter(mine),
      // And the other kind of out-of-date, in its own field for the reason lib/sync.js
      // gives at `trouble()`: these two are not variants of one problem. A repo in
      // `trouble` is one this Mac could not read, so the list you are looking at is
      // stale and you can see that it might be. A repo in `syncTrouble` reads perfectly
      // — the list is exactly right about this Mac and silently wrong about everybody
      // else's, and there is nothing on the screen to notice. Merging them would let
      // the first, which happens most days, mask the second, which is the one nobody
      // finds out about on their own.
      syncTrouble: syncer.trouble().filter(mine),
      // The tickets JIRA says are assigned to you, across every workspace that has JIRA
      // switched on — see lib/jirapoll.js. Its own field rather than folded into
      // `questions` for the reason `requests` and `consoles` are theirs: a JIRA ticket is
      // not a bead, nothing about it can be answered, and every count over `questions`
      // would be wrong the moment one arrived. Empty on every machine that has not
      // configured JIRA, which is all of them until somebody does.
      //
      // `space` is stamped here rather than held by the poller, exactly as it is for the
      // chat rows above: which space a workspace belongs to is a fact about this config
      // and changes without JIRA being asked anything. The inbox filters on it before it
      // looks at anything else, so a row without one collects under "Other" and vanishes
      // the moment a space is picked — and it is also the whole of how a quiet space's
      // tickets end up as quiet as its questions.
      //
      // `ingest` is stamped here for the same reason and from a different place: the
      // poller knows what JIRA said and nothing about what beadcause did with it, and
      // the row has to say both. It carries the state (`reading`, `queued`, `done`,
      // `failed`), the epic's id once there is one, and how many children came of it —
      // which is the whole of step 5 of bc-0i27: the parent id appears on the row when
      // the reading has finished, and until then the row says it is still reading. Null
      // for a ticket the ingester has not reached, which is every ticket for the first
      // few seconds after it arrives.
      //
      // `bead` and `held` are what make the row's three controls possible (bc-0i27.7),
      // and they are the *epic's* rather than the ingestion's: `bead` is read straight
      // out of the filer's in-memory map — no `bd` call, on a payload every parked phone
      // rebuilds — and it is there from the minute the epic is filed, which is long
      // before `ingest.epic` is. `held` is whether the hold is still on it, which is
      // what lets a row say *approved* rather than offering approve a second time. Both
      // are `null` until the epic exists, and the row draws that as a bead on its way
      // rather than as an error. See `epicFor` in lib/jiraepic.js.
      //
      // And the cancelled ones are gone from here entirely: a ticket you cancelled is
      // not a row, on this sweep or any sweep after a restart (lib/jiracancel.js).
      tickets: liveTickets(held).filter(mine).map(stampTicket),
      // And the cancelled ones after all, in a field of their own — which is not a
      // walking back of the line above it. They are **not rows**: nothing counts them,
      // no chip draws them and the list does not hold them. They are here because
      // beadify lives on a ticket's own view (bc-0i27.6) and a view with no way in is a
      // button that does not exist, so the inbox keeps a fold at the foot of its ticket
      // section that these fill. Only the ones JIRA still says are assigned to you —
      // see `cancelledTickets` in lib/jiracancel.js — and stamped with exactly the same
      // fields as a live one, because the view that opens over them is the same view.
      cancelledTickets: cancelledTickets(held).filter(mine).map(stampTicket),
      // And the cancel records with no ticket left at all (bc-0i27.19). The field above
      // is a filter over what the poller answered, which is what makes it blind to its
      // own store: a ticket cancelled and then resolved, reassigned, or moved out of the
      // configured projects drops out of it and its record stays on disk for ever with
      // nothing on any screen that can name it. These are those — a walk of
      // `state.json` rather than a filter over the tickets, so they cost the same one
      // read and nothing at all when there are none.
      //
      // They are **not tickets** and are deliberately not shaped like one: there is no
      // summary, no status and no URL to be had, because the only thing beadcause has
      // ever stored about them is the record. `space` is stamped for the reason it is
      // stamped above — the fold obeys the space picker like everything else — and it is
      // `null` for a workspace the config no longer has, which is the commonest way to
      // end up on this list and lands the record under the same "Other" that any
      // spaceless row does.
      //
      // `mine` does NOT apply here, unlike every list above it (bc-0i27.24). A workspace
      // dropped out of the config is usually dropped out of every account's workspaces
      // list too, and this list is the *only* surface a stranded record has — a question
      // or a ticket has another route back (a live workspace, another account); this
      // does not, and once `mine` hides it there is no All that could ever bring it back.
      // So it is exempt the way `requests` is exempt, on the same reasoning, and it can
      // afford to be: every row already names the workspace it came from
      // (`.jira-orphan-ws` in public/app.js), so a record for a workspace this account
      // does not otherwise see reads as "here is where this came from", not as one
      // account's data leaking into another's screen.
      strandedCancels: strandedCancels(held).map((r) => ({
        ...r,
        space: spaceFor(cfg, r.workspace)?.name || null,
      })),
      // And which workspaces could not be asked, unmerged. The same rows ride `trouble`
      // above so the existing banner draws them with no client change at all; this is the
      // one a JIRA section should draw from, because nothing here can be masked by a
      // tracker read that failed a second later.
      jiraTrouble: jira.trouble().filter(mine),
      // The conversations you have open, as rows the inbox draws for itself — see
      // `inboxConsoles`. Its own field rather than folded into `questions` for the
      // same reason `requests` is: a chat session is not a bead, it has no id in any
      // tracker and nothing about it can be answered, so a client that has never
      // heard of the field draws the inbox exactly as it did before. In here rather
      // than on `/api/questions` alone for the reason the rest of this is: a warm
      // inbox refreshing itself off the poll would otherwise drop every chat row the
      // moment anything else moved.
      consoles: inboxConsoles(),
      // The epic board: which roots you own, and which row below descends from which. Its
      // own field for the reason `requests` and `consoles` are — a client that has never
      // heard of it draws the inbox exactly as it did before, and `owned: false` says
      // out loud that this install has no `me` and the whole section is off. See `rootBoard`.
      // Named `rootboard` rather than `board` because the client already has a `state.board`
      // and it is the *pull request* board — two boards on one page is one too many.
      rootboard: await rootBoard(rows),
      filter,
      /**
       * Who this Mac says it is — `cfg.me`, every handle of it, `[]` when nobody has said.
       *
       * Here rather than behind a second fetch of `/auth/whoami` because the inbox needs
       * it for a *rendering* decision on every card it draws: a question addressed to one
       * of these reads "for you" and one addressed to Carol reads her name, and a page
       * that had to await an extra round trip to tell them apart would spend its first
       * paint calling every addressed question somebody else's. The bead sheet's
       * suggestion buttons still use whoami, which answers a different question — who is
       * signed into *this browser*, which on a borrowed phone is not this Mac's person.
       *
       * The whole list rather than the first, unlike the stamp in `ownAddresseeLabels`:
       * one person answers to two addresses and a question addressed to either of them is
       * theirs, so the card has to test against all of them or it will draw a work address
       * as a stranger. See lib/addressee.js.
       */
      me: meHandles(cfg),
      /**
       * When this daemon last read the tracker, and how often it means to — the two
       * numbers public/freshness.js needs to say "the daemon is up and has not looked
       * since 12:04" rather than only "I cannot hear the daemon". Null before the first
       * sweep lands. See `sweptAt`.
       */
      sweptAt,
      sweepEverySeconds: Math.max(5, Number(cfg.pollSeconds) || 30),
      summary: summaryNow(),
    };
  }

  /**
   * The stuck card, rebuilt as of right now rather than replayed from a transition —
   * bc-ka5y.15.8.
   *
   * `stuck_v1` is the one voice that is a state rather than an arrival, and the state
   * lives in two volatile places: the daemon's 256-entry event log, and the phone's
   * Tray, which is documented as dying with the process. So a phone that restarts (or a
   * daemon that does) has nothing left to replay the transition from, even though the
   * thing it announced is still true.
   *
   * Both halves already answer "is it true right now" without a `bd` call:
   * `syncer.trouble()` is the sync half (`state.json`'s `sync` key survives a restart,
   * bc-y3qk.7) and `deployTrouble()` is the deploy half (a directory of a few small JSON
   * files, settled by every poll cycle already). Rebuilding the *same* event shape
   * `sweepSync`/`settleDeploys` would emit on a transition, from the same functions
   * those two call, is what lets the phone's reconciliation reuse `Notifications.stuck`
   * unchanged rather than learning a second wire shape.
   *
   * Unconditional on the payload, unlike `questions`/`requests` — those cost a `bd`
   * sweep across every workspace and are worth skipping on a poll that timed out; this
   * costs an in-memory map read and a handful of file reads, and skipping it on exactly
   * the polls where nothing else changed is the one thing that would leave a lost card
   * lost until the next real transition, which for a conflict is never.
   */
  function currentStuck() {
    const account = activeAccount(cfg, loadState());
    const mine = (row) => inAccount(account, row?.workspace);
    const sync = syncer.trouble().filter(mine);
    const deploys = deployTrouble().filter(mine);
    return [...(sync.length ? [syncStuckEvent(sync)] : []), ...deploys.map((rec) => deployEvent(rec))];
  }

  /**
   * Take out the cards you have set aside — and hand back the ones that are ready.
   *
   * A dismissal is an acknowledgement, not a decision: the bead stays open and the
   * card stops being in your way. Which means something has to bring it back, or
   * dismissing would be the silent-loss failure this whole app exists to prevent.
   * Two triggers, decided when you dismissed it:
   *
   *   - **Its gate cleared.** An epic comes back when every child is closed, a
   *     blocked bead when its blockers are. That is the moment it stops being a
   *     question's future and becomes a question.
   *   - **Somebody said something.** For a bead with no gate, nothing will change
   *     on its own, so a new comment is the only honest trigger there is.
   *
   * The recheck costs one `bd show` per *dismissed* bead per sweep, and only for
   * beads that are still in the inbox at all — a handful, usually none. A bead that
   * has left the sweep has been answered or closed elsewhere, so its record goes
   * with it rather than accumulating forever.
   */
  async function withoutDismissed(rows) {
    const state = loadState();
    const dismissed = state.dismissed || {};
    const keys = Object.keys(dismissed);
    if (!keys.length) return rows;

    const live = new Set(rows.map((q) => q.key));
    const kept = {};
    let changed = false;
    // Prune the records for beads that are no longer in the inbox at all.
    for (const k of keys) {
      if (live.has(k)) kept[k] = dismissed[k];
      else changed = true;
    }

    const byWorkspace = new Map(cfg.workspaces.map((w) => [w.name, w]));
    const back = new Set();
    await Promise.all(
      Object.entries(kept).map(async ([k, rec]) => {
        const ws = byWorkspace.get(k.slice(0, k.indexOf('/')));
        if (!ws) return;
        const hold = await bd.hold(ws, k.slice(k.indexOf('/') + 1));
        // Could not ask — leave it set aside rather than flapping the card back on
        // screen because of a Dolt lock.
        if (!hold) return;
        const ready = rec.gate ? !hold.gate : hold.comments > (rec.comments || 0);
        if (ready) back.add(k);
      })
    );

    for (const k of back) {
      delete kept[k];
      changed = true;
      console.log(`[beadcause] ${k} is back in the inbox — what it was waiting on has cleared`);
    }
    if (changed) saveState({ dismissed: kept });
    return rows.filter((q) => !kept[q.key]);
  }

  /**
   * Take this card off the list, and work out what brings it back.
   *
   * The write half of `withoutDismissed` above, factored out because it now has two
   * callers that must produce byte-identical records: `/api/dismiss`, where setting a
   * card aside is the whole of what you asked for, and a `defers: true` answer, where
   * it is the second half of "not yet" (bc-y9cof). A deferral that recorded a
   * *slightly* different shape would come back on a different trigger from the one the
   * button promised, and the two would drift the first time either is touched.
   *
   * Writes nothing to the tracker — deliberately, and it is the property the whole
   * mechanism rests on. The bead keeps its `human` label and its status; the only
   * thing that changes is beadcause's own idea of what is on your screen. So the card
   * can come back, and an agent reading the bead sees a question that is still open,
   * which it is.
   *
   * Returns `{ ok, gate }`. `gate` is what it will wait on, or null for "back on the
   * next comment" — the caller says that sentence in its own words, because "set aside"
   * and "not yet" are different things to have just done and the log should not pretend
   * otherwise. `ok` is false only under `requireHold` below.
   *
   * **`requireHold` is the difference between the two callers, and it is not fussiness.**
   * `bd.hold` returns null for a bead it could not read — a Dolt lock, usually — and the
   * fallback below then records *no gate and no comments*, which is not a neutral guess:
   * it is the claim that a bead with an open-children gate comes back on the next
   * comment, and that a bead already carrying three comments comes back on the first. A
   * dismissal takes that trade, because you asked for the card to go and a wrong trigger
   * only ever brings it back early. A deferral must not: nothing about the tap says
   * "hide this whatever happens", and a card left visible for one more sweep is a far
   * smaller failure than one hidden behind a condition nobody measured.
   */
  async function setAside(ws, id, { note = null, requireHold = false } = {}) {
    const key = `${ws.name}/${id}`;
    // What has to change before this comes back. Asked now rather than on every
    // sweep, so the common case — a card set aside and never thought about again —
    // costs one `bd show` once, not one per poll forever.
    const read = await bd.hold(ws, id);
    if (!read && requireHold) return { ok: false, gate: null };
    const hold = read || { gate: null, comments: 0 };
    // Baseline the reply poller on whatever we have just written to the thread,
    // exactly as `/api/comment` does. Without it a note or an answer carrying *your*
    // address comes back as "an agent replied" the next time this bead is swept —
    // and on a deferral that reply is itself a trigger, so it would drag the card
    // back moments after it left. Free here: `hold` has already counted the comments.
    hooks.rebaseline?.(key, hold.comments);
    const dismissed = { ...loadState().dismissed };
    dismissed[key] = {
      at: new Date().toISOString(),
      // The gate is the trigger when there is one: an epic comes back when its
      // children are done, a blocked bead when its blockers close. That is the
      // moment it stops being a question's future and becomes a question — and on a
      // deferral it is usually the very thing the answer said to wait for.
      gate: hold.gate ? { kind: hold.gate.kind, reason: hold.gate.reason } : null,
      // And when there is no gate, nothing about the bead will change on its own —
      // so the only honest trigger left is somebody saying something new.
      comments: hold.comments,
      note: note || null,
    };
    saveState({ dismissed });
    return { ok: true, gate: hold.gate || null };
  }

  /**
   * How long a workspace's raw `bd human list` / `bd list --label` / `bd list
   * --exclude-label human` answer stays warm before a request pays to refresh it —
   * bc-1kwl.7. One window for all three: they are swept together as "the inbox" by
   * every caller below, and none of them is more or less current than the others.
   *
   * Ten seconds, the ledger's own window (lib/history.js) and most of the ledger's own
   * argument: a bead that changed a moment ago is still ten seconds stale at worst. The
   * rest of the argument is `tick` below, which is unique to `questions:` — it already
   * re-sweeps this list on bc-1kwl.5's ~5-second change detector, with `refresh: true`
   * so it always pays for a real answer, which means the daemon's own cycle keeps this
   * key warm without any request having to. `foundation:` and `agentbeads:` have no such
   * tick and stand on the window alone, same as `board:`/`prs:`/`queue:` do.
   */
  const INBOX_FRESH_MS = 10_000;

  /** Every open human-labelled issue, across every workspace. */
  async function allQuestions({ refresh = false } = {}) {
    const store = readActivity();
    // What you already said about any of these, read once for the whole sweep. A bead
    // only has a record here if answering it closed it, so a record plus a row in this
    // list is exactly "answered, and back again" — see lib/answered.js.
    //
    // The quiet arrivals come off the same read, for the same reason: one file, once,
    // rather than once per row.
    const { answered: answers, quiet: quietArrivals } = loadState();
    const results = await Promise.all(
      cfg.workspaces.map(async (ws) => {
        try {
          // On lib/cache.js now — warm or stale spawns no `bd` (bc-1kwl.7). A refresh
          // that fails over a kept answer does not throw here; it comes back with
          // `error` set on the envelope, which is handled the same as a hard failure
          // just below — the rows are last-good and the workspace is still troubled.
          const got = await cacheRead(`questions:${ws.name}`, () => bd.listHuman(ws), {
            freshMs: INBOX_FRESH_MS,
            refresh,
          });
          if (got.error) throw new Error(got.error);
          const rows = got.value;
          const mapped = rows.map((r) => {
            const q = toQuestion(ws.name, r);
            q.activity = activityFor(q.key, r.labels, store);
            // Set when you comment without answering, cleared when an agent
            // replies — it's what tells a session you're waiting on it.
            q.awaitingAgent = (r.labels || []).includes(REPLIED_LABEL);
            // Which group this belongs to, and whether that group is allowed to
            // interrupt right now. The phone uses both: one to file the card, the
            // other to decide whether to make a noise about it.
            q.space = spaceFor(cfg, ws.name)?.name || null;
            // Which of the two channels this belongs in. Read off the label rather
            // than off `q.amendment`, deliberately: a request whose block failed to
            // parse still has to arrive in the foundation channel, carrying its
            // error, rather than falling back into the questions feed where nobody
            // is looking for a constitutional decision.
            q.foundation = (r.labels || []).includes(AMENDMENT_LABEL);
            // The answer you gave the last time this bead was in the inbox, or null.
            // Additive and null almost always, so a client that has never heard of it
            // — an installed Android build, a cached service worker — draws the card
            // exactly as it did.
            q.answeredBefore = answeredBefore(answers, q.key);
            // Whether this card got here without making a noise, and which of the two
            // kinds of quiet it was. Recorded at arrival rather than asked again here
            // — by the time you can see the card the filter is wide enough to show it,
            // so a live answer would always be "it would ring now". See lib/hushed.js.
            // Additive and null for anything that rang, so a client that has never
            // heard of it draws the card exactly as it did.
            q.arrivedQuiet = arrivedQuiet(quietArrivals, q.key);
            return q;
          });
          return sweeps.questions.ok(ws.name, mapped);
        } catch (err) {
          // Not `[]`. A repo that could not be read keeps whatever it last said, and
          // says on the inbox that it could not be read — see lib/sweep.js. The empty
          // list was this app telling you there was nothing to answer, on the strength
          // of a `bd` call that never came back.
          return sweeps.questions.failed(ws.name, err);
        }
      })
    );
    const rows = (await withoutDismissed(results.flat())).sort(
      (a, b) => (a.priority ?? 9) - (b.priority ?? 9) || String(a.createdAt).localeCompare(String(b.createdAt))
    );
    // Counted by workspace rather than by row: `propose()` allows one open ask per
    // advocate, so the two agree in practice, and where they disagree — a second
    // proposal-shaped bead written by hand — one advocate waiting is the true answer.
    proposalsPending = new Set(rows.filter((q) => q.proposal).map((q) => q.workspace)).size;
    // The picker's own summary, over the questions channel only, taken here so it is
    // whatever the last sweep saw rather than whatever this request asked for. The
    // shape is what is read — the names, the 🔕 — and not the counts on it: nothing
    // draws a number beside a space any more (bc-ka5y.1).
    const inbox = splitChannels(rows).questions;
    spacesPending = summarise(cfg, inbox, troubledNames(sweepTrouble(['questions'])));
    // The tracker has been read. Stamped even when some workspaces failed: `trouble`
    // already names those, and this answers the different question of whether anything
    // looked at all. A sweep where every repo failed still *happened*, and reporting it
    // as "nothing has swept since breakfast" would point the reader at the wrong lever.
    sweptAt = new Date().toISOString();
    return rows;
  }

  /**
   * The foundation channel on its own, without sweeping the whole inbox for it.
   *
   * What `/api/foundation` is for. `allQuestions()` is one `bd human list` per
   * workspace and the split above is free once it has run — but a client that wants
   * *only* this channel (the agent scope, which has no questions in it at all; a
   * watch face; a poll for the badge) should not pay for the inbox to learn that no
   * agent is asking for anything, which is the answer almost every time.
   */
  async function foundationRequests({ refresh = false, only = null } = {}) {
    const store = readActivity();
    const results = await Promise.all(
      (only || cfg.workspaces).map(async (ws) => {
        try {
          // On lib/cache.js now (bc-1kwl.7) — see `INBOX_FRESH_MS` for the window and
          // `allQuestions` above for why a kept-but-erroring envelope is thrown here
          // rather than handled separately: it routes to the same `sweeps.foundation.failed`
          // the hard-failure catch below already goes to.
          const got = await cacheRead(`foundation:${ws.name}`, () => bd.listLabel(ws, AMENDMENT_LABEL), {
            freshMs: INBOX_FRESH_MS,
            refresh,
          });
          if (got.error) throw new Error(got.error);
          const rows = got.value;
          const mapped = rows.map((r) => {
            const q = toQuestion(ws.name, r);
            q.activity = activityFor(q.key, r.labels, store);
            q.awaitingAgent = (r.labels || []).includes(REPLIED_LABEL);
            q.space = spaceFor(cfg, ws.name)?.name || null;
            q.foundation = true;
            return q;
          });
          return sweeps.foundation.ok(ws.name, mapped);
        } catch (err) {
          // Held rather than emptied, exactly as the questions sweep does. This one
          // matters for a reason of its own: an agent asking to be changed is the
          // rarest card there is, and a channel that is nearly always empty is the
          // one where an empty draw raises no suspicion at all.
          return sweeps.foundation.failed(ws.name, err);
        }
      })
    );
    return results.flat().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * Every live bead that is not a question, shaped for a card.
   *
   * Deliberately slim. `bd list --json` hands back the full description AND notes
   * of every row — climative alone is 88KB of it — and a card draws none of that,
   * so the list carries only what is on the card and `/api/bead` fetches the body
   * if you actually open one. Without this the payload for `both` across seven
   * workspaces would be most of a megabyte on a phone.
   */
  async function agentBeads({ refresh = false, only = null } = {}) {
    const store = readActivity();
    const results = await Promise.all(
      (only || cfg.workspaces).map(async (ws) => {
        try {
          // On lib/cache.js now (bc-1kwl.7) — see `INBOX_FRESH_MS` and `allQuestions`.
          const got = await cacheRead(`agentbeads:${ws.name}`, () => bd.listAgent(ws), {
            freshMs: INBOX_FRESH_MS,
            refresh,
          });
          if (got.error) throw new Error(got.error);
          const rows = got.value;
          const mapped = rows.map((r) => {
            const key = `${ws.name}/${r.id}`;
            return {
              // `agent` is what the card renderer branches on: these have no
              // decision, no options and nothing to answer, so they must not draw
              // an "Answer & close" button that would close another agent's work.
              agent: true,
              key,
              workspace: ws.name,
              id: r.id,
              title: r.title || r.id,
              question: null,
              priority: r.priority ?? null,
              status: r.status || 'open',
              type: r.issue_type || null,
              actor: shortActor(r.assignee || r.owner),
              // Held for endorsement — the one field on this row that is not about what
              // the bead *is* but about whether anything may be done with it, and the
              // whole of what makes the inbox's Endorsements kind free. These rows are
              // already in this sweep: `bd list` returns a held bead like any other, and
              // until now it drew as one more Unclaimed. The alternative was the cost the
              // chrome refused to pay (see the comment above the topbar in index.html) —
              // a `bd list --label unendorsed` per workspace on every poll — where this
              // is a label test on a row already in hand. `agent` beads only: the human
              // sweep is a different query and never sees one, which is what fixes the
              // kind's `side` to `agent` in inboxfilter.js.
              held: awaitingEndorsement(r),
              createdAt: r.created_at || null,
              // What "since" means depends on the state: a claimed bead has been
              // claimed since started_at, an open one has just been sitting there.
              since: r.started_at || r.updated_at || r.created_at || null,
              dependentCount: r.dependent_count ?? 0,
              commentCount: r.comment_count ?? 0,
              activity: activityFor(key, r.labels, store),
              space: spaceFor(cfg, ws.name)?.name || null,
              sections: [],
              errors: [],
            };
          });
          return sweeps.beads.ok(ws.name, mapped);
        } catch (err) {
          // This is the sweep behind "Nothing live", the empty state bc-ksdc is about:
          // under `Both` and `Agent` the whole list is these rows, so one repo failing
          // here is the difference between a screen of work and a screen saying there
          // is none.
          return sweeps.beads.failed(ws.name, err);
        }
      })
    );
    return results.flat().sort(byUrgency);
  }

  /**
   * Throw the inbox sweeps away — one workspace, or every workspace, across all three
   * channels at once. Same shape as `forgetQueue`/`forgetBoard`: for a write this file
   * does not already special-case (see `cacheDrop` beside `sweeps.questions.forget`
   * above) and for a test that changed the world out from under a kept key.
   */
  const forgetInbox = (workspace = null) => {
    for (const prefix of ['questions:', 'foundation:', 'agentbeads:']) {
      if (workspace) cacheDrop(`${prefix}${workspace}`);
      else cacheDropPrefix(prefix);
    }
  };

  /**
   * How long after filling a key its tracker moving is allowed to fill it again.
   *
   * One cycle by default, and `startPoller` passes its own `cycleMs` so the two can
   * never drift apart. See `warmDue` for why a floor is needed at all.
   */
  const WARM_FLOOR_MS = 30_000;

  /**
   * What the warmer fills on a clock, cheapest first.
   *
   * `key` is one workspace's key, which is what `warmDue` gates on; `fill` takes the
   * workspaces that answered yes. `fill` is the ordinary route-side function rather than
   * a copy of its producer, deliberately: a warmer holding its own copy is two call
   * sites that drift, and the one that drifts is the one nobody tests. See `warmKeys`.
   */
  const WARMABLES = [
    {
      what: 'the foundation channel',
      key: (name) => `foundation:${name}`,
      fill: (only) => foundationRequests({ only }),
    },
    { what: 'the agent beads', key: (name) => `agentbeads:${name}`, fill: (only) => agentBeads({ only }) },
    {
      what: 'the console rows',
      key: workKey,
      // Without the activity store or the live sessions, and that is not a shortcut:
      // neither is in the cached half (see lib/work.js). They decorate rows that have
      // already been swept, so reading them here would cost a file and a directory to
      // build a payload nobody looks at. What this call is for is the four `bd` calls
      // per workspace underneath, and those are keyed on the workspace alone.
      fill: (only) => collectWork(bd, only),
    },
  ];

  /**
   * The other half of the shared cache: filling a key *before* anybody asks for it.
   *
   * bc-1kwl.4. lib/cache.js takes the wait out of every read but the first one — past
   * the window a kept answer comes back now and the producer runs behind it, and only a
   * key with nothing kept at all makes the request that finds it wait. So after
   * bc-1kwl.2/.3/.7 the whole of what is left of the latency budget is *cold keys*, and
   * a cold key is not a rare event: every one of them is cold again the moment the
   * daemon restarts, which for beadcause is every merge.
   *
   * The daemon is already awake on a clock, reading these very trackers. This is that
   * cycle filling the keys behind the screens that are opened from a notification —
   * where "opened" means a phone that has been in a pocket for an hour and where a cold
   * `bd` sweep of every workspace is the first thing between a tap and a list.
   *
   * ## The gate, and why it is two questions rather than a clock
   *
   * A warmer on a plain interval is the obvious build and it is the wrong one: these
   * windows are ten seconds wide and a cycle is thirty, so "warm every cycle" means
   * re-running every producer every cycle, forever, whether or not anything changed.
   * That is the cost bc-1kwl.5 spent a whole bead holding down — *daemon load with
   * nothing moving does not rise* — spent again on screens nobody is looking at.
   *
   * So a key is warmed when either of two things is true, and the second one is what
   * `moved` is for:
   *
   * 1. **Nothing is kept for it.** This is the case the bead is about, and it is the
   *    only one that can make a request wait. It is true at boot, and after any
   *    invalidation.
   * 2. **Its tracker has been written to since we last filled it**, and at least a
   *    cycle has passed. `bd` is the only source these keys have, so if the manifest
   *    has not moved (lib/detect.js) then a kept answer is not merely serviceable, it
   *    is *byte-identical* to what a fresh sweep would return — there is nothing to be
   *    gained by asking, at any age. The floor is what stops a busy afternoon, where
   *    every five-second beat sees a write, from turning this into the interval warmer
   *    above wearing a different hat.
   *
   * On an idle daemon with its keys filled, both are false for every key and this
   * function makes no `bd` call whatsoever. That is the property the acceptance is
   * really about, and it is why the test counts producer calls rather than timing them.
   *
   * ## Sequential, cheapest first, and never on the way to anything
   *
   * The caller runs this detached (see `warmSweep` in `startPoller`) precisely so a
   * sweep for a screen nobody is looking at can never be in front of a question on its
   * way to a phone. Within the pass the order is by cost — the two inbox channels, then
   * the console's four calls per workspace, then the endorsement queue's forty `bd
   * show`s, then the board, then the graph — and it is awaited step by step rather than
   * fanned out, so a warm pass is one thing queueing on Dolt's single writer rather than
   * four.
   *
   * The last three are cold-only and own that rule themselves: `warmQueue` because it is
   * the most expensive sweep in the app bar one, `warmBoard` because it is the only one
   * that reaches the network, `warmGraphs` (lib/graph.js, bc-1kwl.12) because it is the
   * most expensive of all — up to two minutes per workspace — which is exactly why it
   * goes last rather than sharing the `moved` gate the recurring keys above use. All
   * three are argued where they live.
   *
   * Returns the names of what it filled, for one log line and for the suite. It never
   * throws for a tracker: a warm that failed is a key that is still cold, which is
   * exactly the state this ran to improve and never worse than it.
   */
  async function warmKeys({ moved = [], floorMs = WARM_FLOOR_MS, now = Date.now() } = {}) {
    const changed = new Set(moved);
    const all = cfg.workspaces || [];
    const filled = [];
    // Named for the log, and the workspaces are in the line whenever it was not the
    // whole fleet: "filled the console rows (sophab)" is the one shape that says the
    // gate is doing its job, where a bare name reads the same on a quiet daemon as on
    // one re-sweeping everything.
    const say = (what, only) => (only.length === all.length ? what : `${what} (${only.map((w) => w.name).join(', ')})`);

    for (const entry of WARMABLES) {
      // Exactly the workspaces that need it, and the producer is handed that list
      // rather than the fleet — see `warmDue`. An empty list is the ordinary answer on
      // a quiet daemon and costs a `peek` per workspace, which is a `Map` lookup.
      const only = all.filter((w) => warmDue(entry.key(w.name), w.name, { changed, now, floorMs }));
      if (!only.length) continue;
      try {
        await entry.fill(only);
        filled.push(say(entry.what, only));
      } catch (err) {
        // Named rather than swallowed, and the pass carries on. Every one of these
        // producers already keeps its own last-good answer and reports its own failed
        // workspaces to the screen; what a warm pass adds is that the failure happened
        // with nobody waiting on it, so it is a line in the log and not an incident.
        console.error(`[warm] ${entry.what} could not be warmed — ${String(err.message || err).split('\n')[0]}`);
      }
    }

    // Cold-only, both of them, and in this order: bd before the network.
    try {
      // `scopedWorkspaces()` rather than the whole fleet — the queue's key carries its
      // workspace set, so the account that is actually selected is the only one whose
      // key a request will ever read.
      if (await warmQueue(bd, scopedWorkspaces())) filled.push('the endorsement queue');
    } catch (err) {
      console.error(`[warm] the endorsement queue could not be warmed — ${String(err.message || err).split('\n')[0]}`);
    }
    try {
      if (await warmBoard(bd, cfg)) filled.push('the pull request board');
    } catch (err) {
      console.error(`[warm] the pull request board could not be warmed — ${String(err.message || err).split('\n')[0]}`);
    }
    // Last, because it is the most expensive of all of them (bc-1kwl.12) — a `bd
    // graph --all --html` per workspace, up to two minutes on the worst one. Cold-only,
    // like the two above; see `warmGraphs` for why it does not share the `moved` gate.
    try {
      const grew = await warmGraphs(bd, all);
      if (grew.length) filled.push(say('the dependency graph', all.filter((w) => grew.includes(w.name))));
    } catch (err) {
      console.error(`[warm] the dependency graph could not be warmed — ${String(err.message || err).split('\n')[0]}`);
    }
    return filled;
  }

  /**
   * What the bead says about the answer that just arrived: `{ picked, anyCommission }`.
   *
   * `/api/respond` needs two things the answer sentence cannot carry. The first is
   * whether the button that produced it commissions work (`closes: false`) or settles
   * the question; the clients send the option's id alongside the text, and `picked` is
   * that id turned back into the option the agent actually wrote.
   *
   * The second is `anyCommission`, and it is here because of what a *typed* answer used
   * to do. This function returned null for one — it names no option — and null fell
   * through to a close, "which is the only behaviour there has ever been". That is right
   * on a card whose options are all verdicts and wrong on one where an option would have
   * started work: bc-wy06 asked "`worktree-launchagent-fields-jrw0` never reached main.
   * Land it?", Adam typed **"Ship it"**, and the sentence was recorded, the bead closed,
   * and the commission discarded in silence. The branch was still sitting there two days
   * later, and every screen showed the question as settled — a closed bead with a
   * detailed answer on it being, as lib/notinmain.js says of its own subject, the least
   * suspicious thing in the tracker.
   *
   * So a typed answer now has to know whether *any* option on this bead would have
   * commissioned, which is a fact about the bead rather than about the answer. Both
   * fields come off one `bd show`: the lookup was already being paid for on the tapped
   * path, and asking twice would let the two halves of one decision disagree.
   *
   * Deliberately a fresh `bd show` rather than a trusted field on the request. The card
   * in front of you can be a poll out of date, and an option's meaning is the bead's to
   * state — see `optionById` in lib/decision.js.
   */
  const NO_OPTIONS = Object.freeze({ picked: null, anyCommission: false });

  async function answerShape(ws, id, optionId) {
    let issue = null;
    try {
      issue = await bd.show(ws, id);
    } catch {
      // Not being able to ask is not "it commissions work", and it is not "it does not"
      // either — it is no evidence at all. The close gate gets the same refusal from bd a
      // moment later, so an answer that cannot be looked up ends where answers have
      // always ended rather than being held open on a failed read.
      return NO_OPTIONS;
    }
    if (!issue) return NO_OPTIONS;
    const question = toQuestion(ws.name, issue);
    const wanted = String(optionId || '').trim();
    return {
      picked: wanted ? optionById(question, wanted) : null,
      // A **deferral** is excluded, and that is the one subtlety in this line. It is
      // `closes: false` like a commission (see lib/decision.js) and it starts no work,
      // so a typed answer on a card that offers "not yet" is at no risk of dropping an
      // instruction — which is the only thing this field exists to prevent. Counting it
      // would make every typed answer on every card carrying a park option come back
      // "pick an option", swapping the tax bc-7qo.11 removes for a new one.
      anyCommission: (question?.decision?.options || []).some((o) => o.closes === false && !o.defers),
    };
  }

  /**
   * Create what an advocate asked to create — and nothing else, ever.
   *
   * An advocate may open a session on a bead you filed without asking; filing a
   * bead *for* you is a different act, because it makes you answerable for
   * something an agent thought of. So the proposal arrives as an ordinary question
   * carrying the full text of every bead it wants, and this runs only when the
   * answer is the approval option's own response string.
   *
   * Consent is checked against that marker rather than against an option id,
   * because the phone and an ntfy action button both send back only the response
   * text. Free text therefore cannot create anything by accident: "yeah go on
   * then" is a comment, which is exactly what it looks like.
   */
  async function createProposed(ws, id, response, picked, edits, { actor = null } = {}) {
    const none = { created: [], declined: [], skipped: [] };
    // `picked` is what the app sends: the 1-based indices you approved, row by row.
    // The text is the fallback for the two paths that can only carry text — an ntfy
    // action button, and an answer you typed.
    const wanted = Array.isArray(picked) && picked.length ? { all: false, indices: picked } : parseApproval(response);
    if (!wanted) return none;

    let issue = null;
    try {
      issue = await bd.show(ws, id);
    } catch {
      return none;
    }
    if (!issue) return none;

    const source = [issue.description, issue.design, issue.notes].filter(Boolean).join('\n\n');
    const proposal = parseProposal(source);
    if (!proposal) return none; // An ordinary question that happened to be answered "CREATE: …".
    if (proposal.error) throw Object.assign(new Error(proposal.error), { status: 422 });

    // Your rewrites win over the agent's wording, and they are applied before the
    // pick so an edited row and an approved row are the same row. Every field goes
    // back through the parser's own normaliser — see `applyEdits` in lib/proposal.js.
    const beads = applyEdits(proposal.beads, edits);

    // Numbered from 1 to match the headings in the body — the numbers you are
    // looking at when you decide are the numbers that travel.
    const chosen = wanted.all ? beads : beads.filter((_, i) => wanted.indices.includes(i + 1));
    // What was refused is recorded too. A proposal answered "create 1 and 3" and
    // closed with only the created ids reads, later, as though 2 was never offered.
    // Off the edited list, not the parsed one: `chosen` holds edited objects, and an
    // identity check against the originals would call every row declined.
    const declined = beads
      .map((b, i) => ({ b, n: i + 1 }))
      .filter(({ b }) => !chosen.includes(b))
      .map(({ b, n }) => `${n}. ${b.title}`);

    /**
     * The last gate before a bead exists: is this already open?
     *
     * The card was flagged when it was written (lib/dupe.js), and that is the half that
     * matters — an informed tap is the whole point. But bc-9frx happened in the gap:
     * two proposals filed the same day, the first approved and worked, and the second
     * still carrying a card written when nothing looked like it. Approving that second
     * one opened a session onto work already committed on another branch.
     *
     * So the live set is asked again, here, and the two cases are treated differently
     * on purpose:
     *
     *   - **Flagged, and still the same bead.** You were told, and you tapped anyway.
     *     That is a decision — the existing bead may genuinely be a different thing —
     *     and it is honoured, with the resemblance recorded on the thread.
     *   - **Not flagged.** Nothing on the card mentioned it, so the tap cannot have
     *     meant it. The create is refused and named on the thread rather than done
     *     quietly, because the alternative is the wasted window this bead is about.
     *
     * A lookup that fails creates everything, as it always did: a duplicate costs a
     * session, and a `bd list` outage that silently swallowed approvals would cost the
     * tracker itself.
     */
    let live = [];
    // Nothing approved is nothing to check, and one `bd` call is worth guarding: an
    // answer that declined every row must not cost a sweep of the tracker.
    if (chosen.length) {
      try {
        const rows = await bd.listStatus(ws, 'open,in_progress,blocked');
        live = liveCandidates(rows, {
          // The question being answered is excluded — the titles it proposes are the
          // titles being created, and every row would be a duplicate of itself.
          ignore: [id],
          proposalLabel: PROPOSAL_LABEL,
          // Beads only. Another *proposal* naming the same work is worth a flag on a
          // card and is not grounds for refusing a create: nothing it asks for exists
          // yet, and whichever is approved first is the one that becomes real.
          pending: false,
        });
      } catch (err) {
        console.error(`[advocate] ${ws.name}: creating without a duplicate re-check — ${err.message.split('\n')[0]}`);
      }
    }
    const skipped = [];
    const toCreate = [];
    for (const bead of chosen) {
      const hit = live.length ? findDuplicate(bead.title, live) : null;
      const informed = hit && bead.duplicate?.id === hit.id;
      if (hit && !informed) {
        skipped.push(`${bead.title} — ${dupeNote(hit)}`);
        console.log(`[advocate] ${ws.name}: refused to create "${bead.title}" — ${dupeNote(hit)}, and the card did not say so`);
        continue;
      }
      if (informed) console.log(`[advocate] ${ws.name}: creating "${bead.title}" over a flagged duplicate of ${hit.id} — you said so`);
      toCreate.push(bead);
    }
    if (skipped.length) {
      await bd
        .comment(
          ws,
          id,
          [
            `**Not created — ${skipped.length === 1 ? 'it is' : 'they are'} already filed.**`,
            '',
            ...skipped.map((s) => `- ${s}`),
            '',
            'This card was written before that bead existed, so approving it cannot have meant "make a second one". ' +
              'If it really is different work, propose it again — the card will say what it resembles and the approval will stand.',
          ].join('\n')
        )
        .catch(() => {});
    }

    const created = [];
    // Where the approved beads land, resolved once for the batch: the root the card you
    // just approved sits under, or the unsorted backlog (lib/homing.js). Without it, a
    // tap that says "yes, do this work" files beads the advocate is then refused at the
    // door for having nothing decided above them — the approval and the hold contradicting each
    // other with nothing on screen reconciling them. bc-rfnr.8.
    //
    // `homeIn` waits for the export (~1.3s for one workspace), which the poll path may
    // never do — but this is not the poll path. It is a tap that already spends a `bd`
    // subprocess per bead it is about to create, and the alternative on a cold cache is
    // no parent at all, which is the bug. Once, for the batch, and not inside the loop.
    const { parent: home } = await homeIn(bd, ws, { from: id });
    // The same guard the chat console's create runs, because this is the same hazard on
    // the other proposal path: a block an agent wrote, a tap that approves it, and the
    // card's labels straight through to `bd create`. Dropped labels are commented on the
    // question rather than warned about on a screen — there is no screen here, the tap
    // returns to the list, and the thread is where the account of an approval already
    // lives. bc-xl7n.44, and lib/proposedlabels.js has the argument.
    const dropped = [];
    try {
      for (const bead of toCreate) {
        const proposed = filterProposedLabels(bead.labels, { ref: bead.title });
        dropped.push(...proposed.warnings);
        const newId = await bd.create(
          ws,
          {
            title: bead.title,
            body: bead.description,
            type: bead.type,
            priority: bead.priority,
            acceptance: bead.acceptance,
            design: bead.design,
            notes: bead.notes,
            // Minus any edge to the bead's own parent: bd holds one edge per pair and
            // refuses a second of a different type, so a card whose bead names the very
            // root it is being filed under fails the whole create — and the catch below
            // drops the parent rather than the decoration. bc-xl7n.65.
            deps: withDiscoveredFrom(bead.deps, '', { parent: home }),
            parent: home,
            // `advocate` marks provenance: these were proposed by an agent and
            // approved by you, which is worth being able to search for later. The tier
            // is the card's, not the agent's — you saw it printed beside the type and
            // the priority, and an edit could have changed it — so it is written from
            // the bead the tap approved rather than from the block as it was proposed
            // (bc-nc6o).
            labels: ['advocate', ...proposed.labels, ...complexityLabels(bead.complexity)],
          },
          // The agent wrote the words; the approval is what made the bead. `created_by`
          // records who approved it, and the `advocate` label beside it still says who
          // proposed it — the two together are the whole provenance, which neither is
          // on its own. The refusal notes above stay the daemon's: they are its account
          // of what it would not do, not anything you said.
          { actor }
        );
        if (newId) created.push(newId);
      }
    } catch (err) {
      // Partial creation is a fact, not a state to hide. Record what did get made
      // before the failure reaches the caller and leaves the question open.
      if (created.length) {
        await bd
          .comment(ws, id, `Created ${created.join(', ')} before this failed: ${err.message.split('\n')[0]}`)
          .catch(() => {});
      }
      throw err;
    }

    // Said out loud, on the thread and in the log. A label silently dropped is the same
    // failure as a label silently set — you would still be reading a bead that does not
    // carry what the card said it would. Best-effort: a comment that fails must not
    // undo an approval that landed.
    if (dropped.length) {
      console.log(`[advocate] ${ws.name}: ${dropped.length} label(s) on ${id} were the daemon's — ${dropped.join('; ')}`);
      await bd.comment(ws, id, `Filed without ${dropped.length} label(s):\n\n- ${dropped.join('\n- ')}`).catch(() => {});
    }

    for (const newId of created) bus.emit({ type: 'created', key: `${ws.name}/${newId}`, workspace: ws.name, id: newId });
    console.log(
      `[advocate] ${ws.name}: you approved ${created.length} of ${proposal.beads.length} bead(s)` +
        `${created.length ? ` — ${created.join(', ')}` : ''}` +
        `${skipped.length ? `, ${skipped.length} already filed` : ''}`
    );
    return { created, declined, skipped };
  }

  /**
   * Close the work bead a merge just finished — or say why it is still open.
   *
   * One edge stands between a merge and a closed work bead. `bin/deliver.js` parks the
   * work bead behind its merge card, so the advocate cannot open a second session onto
   * work already sitting in a pull request. That edge is also a blocker, and bd refuses
   * to close a bead with an open blocker — so the close below was refused **every
   * single time**, because the card doing the blocking is the one being answered and it
   * does not close until `bd.respond`, further down the handler. The failure was a
   * `console.error` under a card that said the opposite.
   *
   * So: drop that edge first. It exists to keep the bead out of `bd ready` while the
   * question is unanswered, and the question is being answered right now — the moment
   * it stops meaning anything is exactly this one. Then ask the gate, because a
   * *second* card for the same pull request (bc-8fyu: a re-delivery used to file one)
   * or any unrelated blocker still refuses the close, and that refusal has to be
   * reported as a refusal rather than swallowed.
   *
   * Whatever is left owing goes to lib/owed.js and is retried by the poll. Nothing here
   * throws: the merge has already happened at GitHub, and no bead refusing to close can
   * make that untrue.
   */
  async function finishWorkBead(ws, workId, questionId, reason, { actor = null } = {}) {
    await bd.dropDep(ws, workId, questionId).catch((err) => {
      // Not fatal, and often not even wrong: a delivery whose `dep add` failed, or a
      // hand-filed card, never had the edge. The gate below is what decides.
      console.error(`[pr] ${ws.name}: could not drop ${workId} → ${questionId} — ${err.message.split('\n')[0]}`);
    });

    // The reason rides along because two gates are about the sentence rather than the
    // bead: an epic does not close because a pull request merged, and neither does a
    // `gate` or `needs-approval` bead (lib/bd.js, lib/approval.js). An ordinary work
    // bead — which is what this nearly always is — is unaffected by both.
    const gate = await bd.closeGate(ws, workId, { reason });
    if (!gate) {
      try {
        await bd.close(ws, workId, reason, { actor, overClaim: true });
        // A close that went through owes nothing. Ordinarily there is no record to
        // drop — but a merge that retires *two* cards for one pull request tries this
        // twice, and the first attempt is refused by the second card. Without this the
        // ledger would carry a bead that closed seconds later, until the next sweep
        // noticed and dropped it as `already`.
        forgetOwed(ws.name, workId);
        return { closed: true, why: '' };
      } catch (err) {
        const why = String(err.message || err).split('\n')[0];
        console.error(`[pr] ${ws.name}: could not close ${workId} — ${why}`);
        oweClose({ workspace: ws.name, id: workId, reason, why, actor });
        return { closed: false, why };
      }
    }
    // A merge-reason refusal on an epic is not "not yet", so it is not owed: the retry
    // would carry the same sentence and be refused by the same rule forever. What the
    // merge deserves is a note on the epic, which is the record that used to live in the
    // close reason, and the epic stays open for somebody to close on the theme.
    if (gate.kind === 'merge-reason' || gate.kind === 'approval') {
      console.log(`[pr] ${ws.name}: ${workId} stays open — ${gate.reason}`);
      // Two sentences for two rules, because the reader has to know which one this was.
      // `merge-reason` is an epic and the close was asking the wrong question of it;
      // `approval` is the one law (lib/approval.js) and the close was one an agent may not
      // make at all — including this one, which arrived on a tap on Merge. Merging is your
      // act and closing a gate is a different act, and the whole of the rule is that the
      // second one is not implied by the first.
      const note =
        gate.kind === 'approval'
          ? `${reason}. This bead stays open: ${gate.reason}.`
          : `${reason}. This epic stays open: ${gate.reason}. Close it when the theme is done, not on this merge.`;
      await bd
        .comment(ws, workId, note, { actor })
        .catch((err) => console.error(`[pr] ${ws.name}: could not note the merge on ${workId} — ${String(err.message || err).split('\n')[0]}`));
      return { closed: false, why: gate.reason };
    }
    console.log(`[pr] ${ws.name}: ${workId} cannot close yet — ${gate.reason}; owed until it can`);
    // `actor` rides along so the retry, minutes later on a poll with no request behind
    // it, closes under the same name this close would have. See lib/owed.js.
    oweClose({ workspace: ws.name, id: workId, reason, why: gate.reason, actor });
    return { closed: false, why: gate.reason };
  }

  /**
   * Retire the inbox cards a merge from the PR board has just spent.
   *
   * A delivery that could not merge itself files a "Merge #N?" card, and the ordinary
   * way that ends is a tap on the card. The other way is /prs: same pull request, same
   * merge, a different screen — and until this existed, that left the card open. An
   * open `human` bead asking to merge something already merged, in the one list whose
   * whole premise is that everything in it needs you.
   *
   * ## Why the board writes to the tracker at all
   *
   * Because something already does, on exactly this evidence. lib/landed.js sweeps
   * GitHub's merged pull requests every ten minutes and closes both the card and the
   * work bead behind it, and it does not care *where* the merge happened — a board
   * merge is caught by it like any other. So the choice was never "does a merge close
   * the card"; it was "does it close ten minutes later with a sentence that says the
   * merge happened on github.com, or now, with the truth". This is now.
   *
   * ## Why it is a close and not an answer
   *
   * The card is closed with a reason, not answered with `MERGE:` under Adam's name.
   * Nothing here should author a decision he did not type — he merged a pull request,
   * which is a fact, and the card is spent *because of* that fact rather than because
   * it was answered. `bd.respond` would put words in the thread that nobody said;
   * a close reason says what happened and who to blame for it.
   *
   * ## What it will not do
   *
   * Match on the work bead. `cardsForDelivery` can, and bin/deliver.js wants it to —
   * a re-delivery supersedes the card for the branch it abandoned. Here it would mean
   * merging #7 closing an open card about #9 because both are for the same bead, and
   * that card is still a real question. So: this repo, this number, nothing else.
   *
   * Nothing throws. The merge has already landed at GitHub and no bead refusing to
   * close can make that untrue — every failure is a sentence on the way out, and the
   * work bead's own refusal goes to lib/owed.js to be retried, exactly as a tap's does.
   */
  async function retireDeliveryCards(ws, { number, repo = '', base = 'main', sha = '', actor = null }) {
    const out = { cards: [], why: '' };
    let rows;
    try {
      rows = await bd.listLabel(ws, DELIVERY_LABEL);
    } catch (err) {
      out.why = `could not read the ${DELIVERY_LABEL} cards — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }

    const landed = sha ? ` as ${String(sha).slice(0, 8)}` : '';
    const reason = `Merged #${number}${landed} into ${base} from the PR board`;
    for (const card of cardsForDelivery(rows || [], { repo, number })) {
      // The record first, and on the card rather than only in the close reason: a
      // close reason is a line `bd show` prints, and what the next reader of this
      // thread needs is why a question they never answered is not there any more.
      await bd
        .noteOnly(
          ws,
          card.id,
          `## Merged #${number}${landed} from the PR board\n\n` +
            `Merged into \`${base}\` from /prs rather than by answering this card, so there is nothing ` +
            `left here to decide. Closed without an answer — nothing was chosen on your behalf.`,
          // Attributed for the same reason the card's own merge is (bc-5l8s): merging
          // #7 on the board and merging it by answering its card are one decision
          // reached two ways, and they close the same beads. A name on one and not the
          // other would read as two people having done it.
          { actor }
        )
        .catch(() => {});

      try {
        await bd.close(ws, card.id, reason, { actor });
      } catch (err) {
        const why = String(err.message || err).split('\n')[0];
        console.error(`[pr] ${ws.name}: could not close ${card.id} — ${why}`);
        out.cards.push({ id: card.id, bead: card.bead, closed: false, why, work: null });
        // The work bead is parked behind this card, so a card that would not close
        // means a work bead that cannot either. Left for lib/landed.js's sweep.
        continue;
      }

      const work =
        card.bead && card.bead !== card.id
          ? await finishWorkBead(ws, card.bead, card.id, `Merged #${number}${landed} into ${base}`, { actor })
          : null;
      out.cards.push({ id: card.id, bead: card.bead, closed: true, why: '', work });
      console.log(
        `[pr] ${ws.name}: retired ${card.id} — ` +
          (!work ? 'no work bead named' : work.closed ? `closed ${card.bead}` : `${card.bead} stays open — ${work.why}`)
      );
    }
    return out;
  }

  /**
   * Merge what a worker built — and nothing else, ever.
   *
   * The third answer that writes something, and the only one that writes outside
   * this Mac. A worker pushes a branch, opens a pull request, and normally merges it
   * itself (bin/deliver.js) — so a question carrying a PR's identity in a `beadpr`
   * block means the merge *did not* happen: GitHub refused it, a check went red, the
   * checks never reported, or the session asked for a human outright. This is what
   * turns the tap on that question into the merge.
   *
   * That makes this path rarer and more important than it was, not less. It used to be
   * the way all work landed, which meant it was exercised constantly; it is now the way
   * the awkward work lands, and every card that reaches it is one where something has
   * already gone differently.
   *
   * Four answers, all of them recorded:
   *
   * - **Merge.** `gh pr merge`, then close the *work* bead with the PR number in
   *   its reason. Two beads move: the question closes because it was answered, and
   *   the work closes because it landed. Deliberately in that order — if the merge
   *   fails, the question stays open and answerable rather than closed on a promise
   *   nothing kept, which is the same discipline `createProposed` keeps.
   * - **Ship it.** The same merge, and then the repo's declared deploy on top, so what
   *   is *running* changes and not only what is on `origin`. The deploy is deliberately
   *   **not started here** — see below; this returns it as a plan and `/api/respond`
   *   starts it once the answer is durable. A repo with no deploy declared still
   *   merges, and the note says why nothing was deployed: the merge is the half that
   *   was asked for twice, and throwing it away over a missing config entry would be
   *   the worst possible reading of "ship it".
   * - **Request changes.** The note goes on the PR *and* on the work bead, and the
   *   work bead is reopened and unclaimed so `bd ready` offers it again. Without the
   *   reopen the note would sit on a bead the advocate can never pick up, and the
   *   branch would wait forever for a session nobody was going to open.
   * - **Decline.** The approach was wrong rather than the branch: the PR closes, the
   *   branch is abandoned, and the bead is reopened and unclaimed for a fresh start.
   *   Never *closed* — deciding against an attempt is not deciding against the thing
   *   it attempted. The optional direction is written onto the bead, because a
   *   decline carrying nothing tells the next session only that its predecessor was
   *   wrong, which is exactly enough information to do the same thing again.
   *
   * ## Why ship hands its deploy back instead of running it
   *
   * A beadcause deploy SIGKILLs beadcause — this process, mid-request (lib/deploy.js).
   * Everything above runs *before* `bd.respond` writes the answer and closes the
   * question, which is the whole discipline of this function: nothing is closed on a
   * promise until the thing promised has happened. Starting the deploy here would
   * invert that, and the case it inverts it in is the one where the process does not
   * survive to notice — the merge lands, the daemon dies, and the question is still
   * open with a PR that is already merged behind it.
   *
   * So the fourth field on the return value is a `deploy` plan and never a started
   * deploy. `/api/respond` runs it last of all, after the answer is written, the bead
   * is closed and every client has been told. Whether the deploy *can* start is
   * settled here, though, because the note is written here and a note that promises a
   * deploy nothing will run is the same lie by a shorter route.
   */
  /**
   * Which checkout a delivery card's pull request is in — `{ unit, dir }`.
   *
   * A card names its repo the way everything outside this Mac does: a GitHub slug, in the
   * `beadpr` block or in the pull request's own URL. Until bc-l853.6 every caller here
   * resolved the *workspace's* directory instead, which for a workspace of forty checkouts
   * means `gh pr merge 123` running in `architecture` for a pull request in
   * `athena-service` — and that call does not fail, because `architecture` has a #123 too.
   * It merges the wrong pull request.
   *
   * So the slug is matched against the board, which has already asked every approved repo
   * for its remote, and a card naming a repo that is not on it is **refused**. A workspace
   * that is one repo skips all of it and resolves exactly as it always did.
   */
  async function unitForDelivery(ws, d) {
    if (!multiRepo(cfg, ws.name)) {
      try {
        return { unit: { workspace: ws.name, repo: null, key: ws.name, problem: null }, dir: resolveSessionDir(cfg, ws) };
      } catch (err) {
        throw Object.assign(new Error(`no checkout for ${ws.name}: ${err.message}`), { status: 409 });
      }
    }
    const slug = slugOf(d);
    const board = await collectBoard(bd, cfg);
    // Ahead of `pickCard`, because a board that could not be swept has no repos at all
    // and the refusal below would then blame the *repo* — "no approved sophab repo is
    // named on this card" — for a board that simply did not answer (bc-19vt).
    if (board.unavailable) throw Object.assign(new Error(board.unavailable), { status: 409 });
    const card = slug ? pickCard(board, { workspace: ws.name, slug }) : null;
    if (!card) {
      throw Object.assign(
        new Error(
          `no approved ${ws.name} repo is ${slug || 'named on this card'} — #${d.number} cannot be acted on from here ` +
            `until that repo is in repos.${ws.name}.approved, because acting on it in the wrong checkout would act on a different pull request`
        ),
        { status: 409 }
      );
    }
    return {
      unit: {
        workspace: ws.name,
        repo: card.repoName ? { name: card.repoName, token: card.token, dir: card.dir } : null,
        key: card.key,
        problem: null,
      },
      dir: card.dir,
    };
  }

  /**
   * ## The red-base hold — bc-arf8, and lib/redbase.js for the decision half
   *
   * Adam's rule, written down after running it by hand on 2026-08-17: *when main's CI
   * fails, hold the merge worker, file a P0 for the failure, open a session on it
   * immediately, and once the fix is merged close the P0 and resume the merge worker.*
   * Everything below is the hand — the reading, the two writes, and the window.
   *
   * It lives inside `runMergeQueue` rather than beside it because it is the same feature
   * and shares its failure: the queue's own `try` in the poll cycle is what catches it,
   * so a broken watch is reported as a broken merge queue rather than as a second thing
   * to go looking for. That is deliberate — a sweep that swallowed its own failure would
   * need a `sweepFailed` label of its own, and one broken feature reported as two is the
   * shape test/crash.mjs exists to keep the list of.
   */

  /**
   * What this process has filed, per base — `${workspace} ${key} ${base}`.
   *
   * Not a record and not a source of truth: the tracker is, through `findHold`. This is
   * only a guard against the one window in which the tracker cannot answer — `bd.graph`
   * caches for a minute, so a P0 filed thirty seconds ago is invisible to the very next
   * tick, and a second one would be filed on top of it with a second window behind it.
   * The graph is refreshed after each write for the same reason; the map is what covers
   * the refresh itself failing.
   *
   * It is also the fallback when the export failed outright: a hold this process knows it
   * filed keeps holding, because reading "I could not ask" as "there is no hold" would
   * resume the queue on exactly the loaded Dolt where everything else is slowest.
   */
  const heldBases = new Map();
  const firstLine = (err) => String(err?.message || err).split('\n')[0];
  const baseKey = (ws, key, base) => `${ws} ${key} ${base}`;

  /**
   * Open the window on a hold bead — past the workspace advocate, which may be paused.
   *
   * This is the third bullet of the runbook and the one with no existing path: pausing
   * advocates is the only per-worker lever there is (`/api/admin`'s `what` is `all |
   * advocates | terminals`), and pausing them to stop the queue would also stop the fix
   * being dispatched. So the window is opened here, directly, the way `POST /api/session`
   * opens one — the pause is a property of the advocate tick and this is not it.
   *
   * Five refusals in front of it, and each one is a window that should not exist:
   * sessions turned off or this daemon only observing; **a workspace that is not enrolled
   * for unattended agents at all**; a bead somebody has already claimed, which is the
   * ordinary state thirty seconds after the first window came up; a live session already
   * named after it, through the same `advocateSession` every other door here uses; and no
   * room in the Mac's one window budget. The last is a *wait* and not a failure — the bead
   * is filed, endorsed and P0, so the next tick opens it, and the workspace advocate will
   * pick it up as ordinary ready work in the meantime.
   *
   * **Enrolment is not the pause, and only one of the two is bypassed here.** `advocates`
   * is a roster of the workspaces Adam has said may have windows opened on them unasked,
   * and going around *that* would open an unattended session in a workspace he never
   * enrolled — a shared tracker, somebody else's repo. `paused` is a different fact about
   * an enrolled workspace, it is what the runbook says to reach for while the base is red,
   * and it is exactly what this ignores. `roster()` reports a paused advocate as
   * `advocated: true`, which is what makes the distinction free to read.
   *
   * Best-effort throughout: the bead is what holds the queue, and a window that would not
   * come up must never be the reason the hold is not recorded.
   */
  async function openHoldSession(ws, id, { log }) {
    if (cfg.openSessions === false) return false;
    if (OBSERVING) return false;
    if (!advocates.roster().some((r) => r.workspace === ws.name && r.advocated)) return false;
    let row = null;
    try {
      row = await bd.show(ws, id);
    } catch {
      return false;
    }
    if (!row || String(row.status || '').toLowerCase() !== 'open') return false;
    if (String(row.assignee || '').trim()) return false;
    const key = `${ws.name}/${id}`;
    if (advocateSession(liveSessions(cfg), id, { openedAt: openedRecently(key) })) return false;
    const g = advocates.globals();
    if ((g.live || 0) + (g.resolvers || 0) >= (g.maxWorkers || 0)) {
      log(
        `${id}: the base is red and nothing can open on it yet — ${g.live} workers and ${g.resolvers} ` +
          `resolvers against a cap of ${g.maxWorkers}`
      );
      return false;
    }
    rememberAdvocateOpened(key);
    try {
      const { dir } = await openWorkSession(cfg, ws, row, { bd });
      log(`${id}: opened a session on the red base in ${dir}`);
      return true;
    } catch (err) {
      log(`${id}: could not open a session on the red base — ${firstLine(err)}`);
      return false;
    }
  }

  /**
   * One base, one tick — the wiring, and deliberately nothing else.
   *
   * `sweepBase` in lib/redbase.js is the procedure; everything below it is an adapter onto
   * a door that already existed, in the same shape `runMergeQueue` itself takes: the
   * reading is `pr.baseChecks`, the rows are the `bd.graph` index the epic board keeps
   * warm, the two writes are `bd.create` and `bd.close`, and the window is the one
   * `POST /api/session` opens. Nothing here decides anything.
   *
   * Returns the hold record lib/mergequeue.js consults, or `null` for a base nothing is
   * holding.
   */
  async function checkBase(ws, { key, dir, base }, { log }) {
    const memo = baseKey(ws.name, key, base);
    const say = (line) => log(`[merge-queue] ${ws.name}: ${line}`);
    const out = await sweepBase(
      { key, base, last: heldBases.get(memo) || null },
      {
        checks: () => pr.baseChecks(dir, base),
        // `null` and not an empty list for a graph that failed or has never been read —
        // "I could not ask" and "there is no bead" are the two answers `sweepBase` must
        // be able to tell apart, and reading the second for the first files a second P0.
        rows: async () => {
          const index = await bd.graph(ws).catch(() => null);
          return !index || index.error ? null : index.beads;
        },
        file: (issue) => bd.create(ws, issue),
        // `overClaim`, because by the time the base is green again the bead is normally
        // claimed by the session that fixed it — and this close is the hold lifting, not
        // an agent deciding the work is done.
        close: (id, reason) => bd.close(ws, id, reason, { overClaim: true }),
        comment: (id, text) => bd.comment(ws, id, text),
        settle: () => bd.graph(ws, { refresh: true }),
        announce: (id) => bus.emit({ type: 'red-base', key: `${ws.name}/${id}`, workspace: ws.name, id }),
        open: (id) => openHoldSession(ws, id, { log: say }),
        log: say,
      }
    );
    if (out.hold) heldBases.set(memo, out.hold);
    else heldBases.delete(memo);
    return out.hold;
  }

  /**
   * `checkBase`, once per base per tick. See `holds` in `runMergeQueue` for why.
   *
   * A base with no checkout resolved is not asked about at all and holds nothing: the
   * queue is about to refuse that pull request anyway with a better sentence (`no checkout
   * on this Mac is …`), and a hold filed off a directory that does not exist would be a P0
   * about a repository this Mac cannot see.
   */
  async function holdOn(ws, { key, dir, base }, holds, log) {
    if (!dir) return null;
    const memo = baseKey(ws.name, key, base);
    if (holds.has(memo)) return holds.get(memo);
    const rec = await checkBase(ws, { key, dir, base }, { log });
    holds.set(memo, rec);
    return rec;
  }

  /** When each base with nothing queued against it was last asked about. */
  const watchedBases = new Map();

  /**
   * How long a quiet base goes unasked.
   *
   * Five minutes, and the number is about what it costs to be wrong in each direction. Too
   * long and a red `main` sits unnoticed on an evening nobody is delivering, which is the
   * failure this half exists for; too short and every single-repo workspace spends a `gh`
   * call a tick answering *green* forever. Nothing is waiting on the answer — the moment
   * anything *is*, the queue asks for itself on its own tick and this clock stops mattering.
   */
  const QUIET_BASE_MS = 5 * 60 * 1000;

  /**
   * The workspace's own base, watched whether or not anything is queued against it.
   *
   * Single-repo only — see the note at the call site. `configuredBase` and not `baseFor`,
   * deliberately: `baseFor` asks GitHub for the repository's default branch and only for a
   * multi-repo workspace, so on the path this runs on the two answer identically and one
   * of them is free.
   *
   * Everything it can fail at is swallowed into a log line rather than thrown, because it
   * shares the merge queue's `try` in the poll cycle and a workspace this Mac cannot place
   * must not stop the queue running for the eight that it can.
   */
  async function watchOwnBase(ws, holds, log) {
    if (multiRepo(cfg, ws.name)) return;
    const base = configuredBase(cfg, ws.name);
    const memo = baseKey(ws.name, ws.name, base);
    if (holds.has(memo)) return;
    const last = watchedBases.get(memo) || 0;
    if (Date.now() - last < QUIET_BASE_MS) return;
    watchedBases.set(memo, Date.now());
    let dir = '';
    try {
      dir = resolveSessionDir(cfg, ws);
    } catch {
      // A workspace with no checkout on this Mac has no base to watch and never will; it
      // is not an error and it is said nowhere, because it would be said every five
      // minutes for the life of the daemon.
      return;
    }
    await holdOn(ws, { key: ws.name, dir, base }, holds, log);
  }

  /**
   * The other half of `watchOwnBase` — a multi-repo workspace's bases, narrowed to the
   * checkouts that actually have something open right now. bc-xl7n.103.
   *
   * `watchOwnBase` deliberately does nothing here: forty `gh` calls every five minutes
   * to watch every approved repo is the wrong trade. But the merge queue's own read
   * (`anyQueued`, below) only ever fires once something has been *delivered*, so a repo
   * with an open pull request nobody has queued yet was watched by nothing at all — the
   * exact hole this bead is about. `openBaseCards` is the board's own answer, already
   * kept warm for the PR page; asking it costs no `gh` call of its own, only however
   * many the board's cache is already due to spend. Each base found still goes through
   * `holdOn`'s per-tick memo and this function's own five-minute clock, same as
   * `watchOwnBase`, so a quiet repo the board keeps listing is not re-asked every tick.
   */
  async function watchQueuedBases(ws, holds, log) {
    if (!multiRepo(cfg, ws.name)) return;
    let board;
    try {
      board = await collectBoard(bd, cfg);
    } catch {
      // Nothing to watch this tick if the board itself could not be read; the next tick
      // tries again, same as a `gh` failure inside `checkBase` would.
      return;
    }
    for (const card of openBaseCards(board, ws.name)) {
      const memo = baseKey(ws.name, card.key, card.base);
      if (holds.has(memo)) continue;
      const last = watchedBases.get(memo) || 0;
      if (Date.now() - last < QUIET_BASE_MS) continue;
      watchedBases.set(memo, Date.now());
      await holdOn(ws, { key: card.key, dir: card.dir, base: card.base }, holds, log);
    }
  }

  /**
   * One pass of the merge queue over every workspace — bc-r941.3.
   *
   * Defined here rather than in the poller because of what it needs, and what it needs is
   * the argument for where it lives: `unitForDelivery` (which checkout a pull request's
   * `gh` calls must run in — bc-l853.6, and getting it wrong merges a different repo's
   * pull request of the same number), `resolveFor` (one resolver window per pull request,
   * a registry that only exists in this process), `requestSweep` and `landParent`. All
   * four are already in this closure and none of them is in the poller's.
   *
   * lib/mergequeue.js is the decision procedure and knows about none of that; this is the
   * wiring, and it is deliberately thin. Everything below is a one-line adapter onto a
   * door that already existed — the merge is `pr.merge`, the same call the button on the
   * phone makes; the resolver is the one the PR board's own conflict button opens; the
   * card is the card a worker used to file. The queue did not add a way into `main`, it
   * moved who walks through the one that was there.
   */
  async function runMergeQueue({ log = (line) => console.log(line) } = {}) {
    const lines = [];
    /**
     * One reading per base per tick, and the whole reason `checkBase` takes a memo.
     *
     * A workspace with six queued pull requests against `main` is six calls to
     * `holdFor`, and every one of them would otherwise be a `gh api …/check-runs` and a
     * `bd export` for an answer that cannot have changed inside a single pass. The memo
     * lives for exactly this tick and is thrown away with it: a hold is a reading, and a
     * reading kept between ticks is what lib/redbase.js's header refuses to build.
     */
    const holds = new Map();
    for (const ws of cfg.workspaces || []) {
      /**
       * The base nobody has anything queued against — the half of the runbook that would
       * otherwise never fire.
       *
       * The queue asks about a base at the moment it is about to merge into it, which is
       * exactly where the harm is and costs nothing when nothing is queued. But it is
       * also nothing at all on a quiet evening: `main` went red at 13:49 on 2026-08-17
       * and the first thing that noticed was a person, and it would have gone unnoticed
       * just as long with an empty queue. So a workspace that is **one repo** — where the
       * base and the checkout are both known without asking anybody, and there is exactly
       * one of each — is watched on its own five-minute clock whether or not anything is
       * waiting to land.
       *
       * A workspace of forty repos is deliberately not watched this way: forty `gh`
       * calls every five minutes to answer a question that only matters where something
       * is about to merge is the wrong trade. `watchQueuedBases`, right below, is the
       * narrower answer for that shape — bc-xl7n.103.
       */
      await watchOwnBase(ws, holds, log);
      /**
       * `watchOwnBase`'s counterpart for a workspace of many repos — bc-xl7n.103. See
       * `watchQueuedBases` for why this is not the forty-`gh`-calls trade that function
       * declines.
       */
      await watchQueuedBases(ws, holds, log);
      /**
       * The cheap no, before the real read — see `anyQueued`.
       *
       * The queue's read is `bd.listAgent`, one process per workspace per cycle, and on
       * an idle laptop nine of those a minute answer *no* every time. `bd.graph()` is
       * cached for a minute and already kept warm by the epic board, and it carries the two
       * fields this question needs. A failed graph read falls through rather than
       * skipping, so a tracker that would not export never quietly stops the queue.
       */
      if (!anyQueued(await bd.graph(ws).catch(() => null))) continue;
      const policy = prPolicyFor(cfg, ws.name);
      let out;
      try {
        out = await sweepMergeQueue(bd, ws, {
          policy,
          owner: ownerName(cfg),
          /**
           * Whether a follow-up this queue files over open review findings arrives workable
           * or held — bc-9ntye.2, and it is the same answer every other filing seam here
           * asks for (lib/filing.js, lib/jiraepic.js, lib/sessionaudit.js). Read here rather
           * than inside the sweep because `cfg` is this process's and the queue's job is a
           * merge, not a settings lookup.
           */
          autoEndorse: autoEndorseAllowed(cfg, ws.name),
          /**
           * Is this branch's base red, and is somebody on it? — bc-arf8.
           *
           * The unit key rather than the workspace name, because `main` being red is a
           * fact about one repository: `where.unit.key` is what `unitForDelivery` already
           * worked out for the merge itself, so the hold is keyed by the same thing the
           * merge is, and a workspace of forty checkouts holds one of them rather than
           * all forty.
           */
          holdFor: (spec, where) =>
            holdOn(
              ws,
              { key: where?.unit?.key || ws.name, dir: where?.dir || '', base: spec?.base || configuredBase(cfg, ws.name) },
              holds,
              log
            ),
          /** Which checkout, or a sentence saying why there is not one. */
          resolve: async (spec) => {
            try {
              const { unit, dir } = await unitForDelivery(ws, spec);
              return { unit, dir, reason: '' };
            } catch (err) {
              return { unit: null, dir: '', reason: String(err.message || err).split('\n')[0] };
            }
          },
          prApi: pr,
          /**
           * The window that delivered this branch, renamed `DONE-` now that it is in
           * `main`. The worker wrote `QUEUED-` when it handed the branch over, which was
           * all it could honestly say — see lib/retitle.js for why the two are split.
           */
          markMerged: (bead) => {
            const line = describeMarked(markWindowMerged(cfg, bead));
            if (line) log(`[merge-queue] ${ws.name}/${bead}: ${line}`);
          },
          /**
           * And the Epic Advocate of the root a review follow-up just landed under, told
           * that it is there — bc-9ntye.3.
           *
           * Wired here rather than reached from inside the queue for `markMerged`'s reason
           * exactly: this is the half that types into an iTerm window, and lib/mergequeue.js
           * stays a pure function of its arguments so a suite can merge a fake pull request
           * without one. The queue has already decided *whether* there is an advocate to
           * tell and *which* root it is; all that is left here is the Mac.
           *
           * Silent when there is nothing to say, which is the ordinary answer: no window on
           * the root means the re-entry sweep opens one on its own `filed` event, and that
           * is not news. See `describeNudge`.
           */
          tellAdvocate: async (ask) => {
            const result = await tellEpicAdvocate(cfg, ask);
            const line = describeNudge(result, ask?.followUp);
            if (line) log(`[merge-queue] ${ws.name}: ${line}`);
            return result;
          },
          /** A conflicted downmerge, handed to the window that resolves one. */
          openResolver: async (entry, dir) => {
            if (cfg.openSessions === false) return false;
            const { unit } = await unitForDelivery(ws, entry.spec).catch(() => ({ unit: null }));
            if (!unit) return false;
            /**
             * As `merge-advocate`, not as a conflict session — and the difference is the
             * permissions rather than the brief.
             *
             * `openConflictSession` is the older, adjacent door and it opens a window with
             * the worker's reach: `bd close` and `gh pr merge` both in it, over somebody
             * else's branch, with the reasons for the code gone. That is exactly the
             * position bc-r941 exists to take the merge out of, so re-using it here would
             * have handed the widest permissions in the codebase back to the one agent
             * this epic narrowed.
             *
             * What is re-used is `resolveFor` — one window per pull request, two on this
             * Mac at once, a queue for the rest — because that registry lives in this
             * daemon's memory and is the reason lib/mergesweep.js records rather than
             * sweeps. Keyed per repo, since two Climative services each have a #1.
             */
            const outcome = await resolveFor(
              unit.key,
              entry.spec.number,
              () =>
                openMergeAdvocateSession(cfg, ws, entry.issue, entry.spec, entry.state, {
                  dir,
                  reason: `the downmerge of \`${entry.spec.base}\` into \`${entry.spec.branch}\` conflicts`,
                  policy,
                }),
              { branch: entry.spec.branch, owner: ownerName(cfg) }
            );
            /**
             * Three answers count as handled, and only the fourth does not.
             *
             * `resolveFor` returns `{ opened }` when a window went up, `{ queued }` when
             * this Mac is at its two-at-a-time cap and it is in line, and `{ reused }`
             * when a session is already on this pull request and was nudged instead. All
             * three mean *somebody is dealing with it*, which is what the `resolving`
             * flag on the merge-bead records — a queue that only believed the first would
             * mark a queued branch as unresolvable and start spending its attempts.
             *
             * `{ status, error }` is the only failure, and it is the one where the bead
             * has to go on and become a card. Note there is no `status` on the success
             * paths at all, which is what made an HTTP-shaped check wrong here.
             *
             * **`held` is a fourth answer that arrives wearing an error, and it is not one**
             * — bc-2caji. `resolveFor` hands back `{ status: 409, held, error }` for a window
             * it can *see* and cannot *type into*: a record restored across a daemon restart,
             * or an iTerm too old to report a session id. Its own comment says why `held`
             * rides out with the error — "a caller that is not a thumb can tell this apart
             * from a failure" — and this is that caller. A window is on the pull request;
             * what is missing is a handle, which is the daemon's problem and not the
             * branch's.
             *
             * Reading it as failure is not a cosmetic mislabel, because of where the false
             * lands: `sweepMergeQueue`'s conflicted path answers it with `record`, which
             * spends an attempt. `BLIND_MS` is thirty minutes and the sweep ticks far more
             * often than that, so a single restart burns all three attempts and
             * `raiseMergeCard` ejects the bead — taking `merge-queue` off it, which is a
             * one-way handover. #410, #433 and #438 were ejected exactly that way on
             * 2026-08-19, each carrying "nothing could be opened to resolve it" over a
             * window that was sitting on screen the whole time.
             */
            if (outcome?.error && !outcome?.held) return false;
            return Boolean(outcome?.opened || outcome?.queued || outcome?.reused || outcome?.held);
          },
          /**
           * And the other end of that door — bc-5mdsw. Is a resolver still on this pull
           * request?
           *
           * The same registry `resolveFor` writes, read rather than written: `find` for a
           * window it believes in, `pending` for one waiting on a slot. Between them they
           * are every state in which *something here is going to deal with this*, and the
           * absence of both, on a branch GitHub still calls conflicting, is the one state
           * the merge-bead could not previously express — a resolver that ended without
           * resolving. `find` already ages a handle-less record out at `BLIND_MS`, so a
           * window restored across a restart counts as live for half an hour rather than
           * being read as gone the moment the daemon comes back.
           *
           * **Every failure answers `true`**, and that direction is the whole of its
           * safety: the sweep spends an attempt on `false`, so a workspace whose unit
           * cannot be resolved must say *somebody is on it* rather than start a branch
           * down the three ticks to a card over a question nobody could answer.
           */
          resolverOn: async (entry) => {
            const { unit } = await unitForDelivery(ws, entry.spec).catch(() => ({ unit: null }));
            if (!unit) return true;
            if (findResolver(unit.key, entry.spec.number)) return true;
            return pendingResolvers().some((e) => e.workspace === unit.key && Number(e.number) === Number(entry.spec.number));
          },
          /**
           * The worker again, on a pull request its reviewer has commented on — bc-36xx.4,
           * and lib/reviewanswer.js is the round it sits in.
           *
           * Through the same `resolveFor` registry as the resolver above, keyed by the
           * same pull request, and that is the point rather than a convenience: one
           * window per pull request whichever door opened it, so a branch being resolved
           * is not also handed a worker, and two ticks a minute apart cannot open two
           * workers on the same review. The three answers that count are the resolver's
           * three, for its reasons — `queued` and `reused` both mean somebody is on it.
           *
           * `openReviewAnswerSession` takes the **review** state, not the queue's: what
           * the brief is built from is the comments and the round, which live in the
           * other block on the same bead.
           */
          openAnswer: async (entry, dir) => {
            if (cfg.openSessions === false) return false;
            const { unit } = await unitForDelivery(ws, entry.spec).catch(() => ({ unit: null }));
            if (!unit) return false;
            const review = reviewState(entry.issue);
            const outcome = await resolveFor(
              unit.key,
              entry.spec.number,
              () =>
                openReviewAnswerSession(cfg, ws, entry.issue, entry.spec, review, {
                  dir,
                  reason: `the reviewer left comments on #${entry.spec.number} and they are yours to answer`,
                  maxRounds: MAX_REVIEW_ROUNDS,
                }),
              { branch: entry.spec.branch, owner: ownerName(cfg) }
            );
            // `held` is handled rather than failed, for `openResolver`'s reason above
            // (bc-2caji): a window that cannot be typed into is still a window on this
            // pull request, and the review round must not spend an attempt for it.
            if (outcome?.error && !outcome?.held) return false;
            // Still one of the three answers that count, and now said as itself —
            // bc-xl7n.129. `queued` means the Mac was full and no window went up, which
            // for a whole afternoon was reported as a window that had; the queue counts
            // this apart so its own card can say what is in line. Truthy either way, so
            // nothing that only asks yes-or-no has changed.
            if (outcome?.queued) return 'queued';
            return Boolean(outcome?.opened || outcome?.reused || outcome?.held);
          },
          /**
           * The reviewer, on a pull request nothing has judged yet — bc-36xx.5, and the
           * door the rest of this epic was built in front of. lib/reviewadvocate.js has
           * held the brief since bc-36xx.1 and nothing imported it; this is what hands it
           * to a window.
           *
           * **Through the same `resolveFor` registry as the two doors above, keyed by the
           * same pull request**, and here that is load-bearing rather than tidy. The review
           * gate holds a branch for as long as it takes somebody to look at it, and the
           * sweep runs every thirty seconds: without the registry a review that took twenty
           * minutes would be twenty windows arguing with the same diff. It is also what
           * keeps the reviewer and the *worker answering it* from being open at once on one
           * branch, which is the case a per-door registry would have missed entirely — one
           * window per pull request, whichever door opened it.
           *
           * **The registry is in this daemon's memory and a restart forgets it**, which is
           * the trap bc-36xx.5 was filed knowing about. Nothing is invented here for it:
           * `restart()` in lib/resolvers.js re-reads the records it wrote to disk and marks
           * them `restored`, and a restored record still *holds* — `resolveFor` answers 409
           * rather than opening a second window at a diff a window on somebody's screen is
           * already reading. The durable record of where a review actually got to is never
           * this registry, it is the review block on the merge-bead (lib/mergebead.js).
           *
           * `outcome.why` is the gate's own sentence and it is what the brief opens with,
           * because "nothing has reviewed this pull request yet" and "the worker has
           * answered every comment from round 1" are two different reviews to be asked for.
           * `reviewState` again rather than the queue's state, for `openAnswer`'s reason:
           * what a round is built from lives in the other block on the same bead — and it
           * is handed over under `nextReviewRound` rather than under the block's own
           * number, because the block counts rounds *finished* and this window is about to
           * conduct the next one. A second reviewer opened under `round: 1` gets the first
           * round's brief and re-reviews the diff it was opened to stop re-reviewing.
           */
          openReview: async (entry, dir, outcome) => {
            if (cfg.openSessions === false) return false;
            const { unit } = await unitForDelivery(ws, entry.spec).catch(() => ({ unit: null }));
            if (!unit) return false;
            const seen = reviewState(entry.issue);
            const review = { ...seen, round: nextReviewRound(seen) };
            const why = String(outcome?.why || '').trim().replace(/\.$/, '');
            const opened = await resolveFor(
              unit.key,
              entry.spec.number,
              () =>
                openReviewAdvocateSession(cfg, ws, entry.issue, entry.spec, review, {
                  dir,
                  reason: why || `#${entry.spec.number} has been delivered and nothing has reviewed it yet`,
                  maxRounds: MAX_REVIEW_ROUNDS,
                }),
              { branch: entry.spec.branch, owner: ownerName(cfg) }
            );
            // The resolver's three-answers-count reading, for the resolver's reasons: a
            // queued slot and a live window already on this pull request both mean somebody
            // is dealing with it, and only `{ status, error }` means nothing is.
            if (opened?.error) return false;
            // And `queued` said as itself, exactly as the answer door above says it, for
            // its reason — bc-xl7n.129.
            if (opened?.queued) return 'queued';
            return Boolean(opened?.opened || opened?.reused);
          },
          /** Out of attempts, or nothing here can fix it: it becomes Adam's card. */
          raise: async (entry, why, opts = {}) => {
            /**
             * And its **Ship it** button, which is the one thing about the card that has
             * to be worked out from the repo rather than from the bead.
             *
             * `bin/deliver.js` read this before filing its own card and the card is the
             * same card, so it is read here for the same reason: a merge that is on
             * `origin` and not running is one tap from being running, and only the repo's
             * own `deploys` declaration knows what that tap does. Best-effort — a
             * declaration that will not parse costs a button, never the handover, which
             * is the same call `deliver.js` made about it.
             */
            let shipHint = '';
            try {
              const { unit } = await unitForDelivery(ws, entry.spec);
              shipHint = unit?.key ? deployHint(deployFor(cfg, unit.key)) : '';
            } catch {
              /* No checkout, or a deploy this cannot read: the card simply offers no Ship. */
            }
            return raiseMergeCard(bd, ws, entry, why, {
              shipHint,
              ...opts,
              owner: ownerName(cfg),
              // Through the same resolver the merge itself uses: a workspace of forty
              // repos has no single directory, and `gh pr comment 42` in the wrong
              // checkout comments on a different repo's #42 without failing (bc-l853.6).
              prComment: async (spec, text) => {
                const { dir } = await unitForDelivery(ws, spec);
                return pr.comment(dir, spec.number, text);
              },
            });
          },
          /**
           * What a merge leaves behind, which is exactly what `landHere` in
           * bin/deliver.js used to do and for the same two reasons: this Mac's own `main`
           * is a commit behind until something fetches, and every other branch open on
           * this base is now measured against a base it has never seen.
           */
          afterMerge: async (entry, landed, where) => {
            requestSweep({
              workspace: ws.name,
              key: where.unit?.key || ws.name,
              number: entry.spec.number,
              base: entry.spec.base,
              why: `the merge queue landing ${entry.issue.id}`,
            });
            await landParent(where.dir, entry.spec.base).catch(() => {});
          },
          /**
           * The notification with nothing to answer, which used to be `bin/deliver.js`'s
           * last act and was moved here for the same reason the merge was.
           *
           * Losing it would have been the quietest regression in that change: work would
           * land correctly, close correctly, and simply stop being mentioned — and the one
           * notification in beadcause that reports a decision *already taken on your
           * behalf* is exactly the one whose absence nobody notices until they go looking
           * for something that shipped a week ago.
           *
           * **Not built inside `afterMerge` above, on purpose — bc-9ntye.5.** `afterMerge`
           * fires before `sweepMergeQueue`'s `finish` runs, and `finish` is where a review
           * follow-up bead is filed and where `findings` — the sentence naming it — first
           * exists. A card assembled in `afterMerge` could only ever say `owed: ''`, which
           * is the gap this bead was filed about: the merge-bead's close reason, the pull
           * request report and the comment on the work bead already named the follow-up,
           * and the phone card did not. `announceLanding` is called from inside `finish`,
           * after `findings` is known, so `owed` can carry it.
           *
           * An event now rather than an ntfy push (bc-ka5y.15.1), which is why there is
           * nothing to `await` and nothing to fail: the phone is already parked on
           * `/api/poll` and this wakes it. The four merge doors are enumerated in
           * lib/mergesweep.js's header, and this is deliberately not on all four — the two
           * that *are* a tap of yours, a delivery card and the PR board's Merge button,
           * must not chime for it, and neither does a pull request Adam merged himself from
           * GitHub or the phone (`finish`'s other caller, "outside the queue"): this option
           * is only ever passed to the call `afterMerge` also runs ahead of. See lib/news.js.
           */
          announceLanding: async (spec, issue, { landed, findings }) => {
            const landing = landedEvent(
              {
                workspace: ws.name,
                bead: spec.bead,
                repo: spec.repo,
                number: spec.number,
                url: spec.url,
                title: issue.title || '',
                base: spec.base,
                sha: landed?.mergeCommit || '',
                owed: findings || '',
              },
              { quiet: mutedNews(cfg, ws.name) }
            );
            bus.emit(landing);
          },
          log: (line) => log(`[merge-queue] ${ws.name}: ${line}`),
        });
      } catch (err) {
        log(`[merge-queue] ${ws.name}: the queue failed — ${String(err.message || err).split('\n')[0]}`);
        continue;
      }
      const line = describeMergeQueue(out);
      if (line) {
        log(`[merge-queue] ${ws.name}: ${line}`);
        lines.push(`${ws.name}: ${line}`);
      }
      // A merge closes two beads and files nothing, so nothing else on this cycle would
      // tell a parked phone that the board has moved. Same argument `sweepMerges` makes
      // about a sweep card: an event that is never emitted reaches the browser whenever
      // something else next happens to move, which on a quiet evening is hours.
      for (const id of out.merged || []) bus.emit({ type: 'merge-queue', key: `${ws.name}/${id}`, workspace: ws.name, id });
    }
    // The tick has just rewritten every block `/api/queues` reads its stages out of, so
    // the twenty seconds `gatherMerges` keeps are exactly the twenty that would be wrong.
    // Unconditional: a pass that refused, downmerged or opened a resolver moved a stage
    // without merging anything, and those are the moves the board exists to show.
    forgetMerges();
    return lines;
  }

  /**
   * Put a delivered worker's bead back in the queue — and find out whether it went.
   *
   * The two answers that end an attempt without ending the work, `changes` and `decline`,
   * both need this and both used to call `Bd.reopen` (bc-36xx.17). That was wrong on this
   * path in a way nothing surfaced: **since bc-r941 a worker delivers and stops.**
   * bin/deliver.js files the card, the window exits, the daemon reaps it minutes later —
   * so by the time this runs, hours later, the bead is claimed by a session that no longer
   * exists, and bd 1.2.1 refuses any reassign whose assignee is not the actor. The bead
   * stayed `in_progress` and assigned, which is out of `bd ready` for good; the delivery
   * card had already closed as answered and nothing re-raises one. Eleven of these on
   * 2026-08-17, two refused (bc-36xx.10 on #401 sat two hours, found by accident on a
   * supervision visit; bc-khoe.7 in the same second). The other nine survived because the
   * worker window happened still to be alive, which is luck.
   *
   * `reopenAbandoned` is the write for a claim whose holder is gone: it tries the plain
   * reopen first and reaches for `--force` only when that specific refusal comes back,
   * saying so out loud. So a claim that really is live still succeeds without forcing
   * anything, and the guard keeps doing its job on the paths it was added for — which is
   * why this is that method and not a flag on `reopen` (lib/bd.js).
   *
   * **The result is returned rather than swallowed**, and that is the other half of the
   * bug. Both callers announced "back in the queue" unconditionally, after a call whose
   * outcome they never looked at, with the refusal logged one line above — so the log read
   * as if the right thing had happened and the only trace of the failure was a bead that
   * had quietly stopped existing. That is what made it two hours of hunting rather than
   * one grep.
   */
  async function handBackWorkBead(ws, bead) {
    if (!bead) return { ok: true, why: null, rearmed: null };
    try {
      await bd.reopenAbandoned(ws, bead);
    } catch (err) {
      const why = String(err?.message || err).split('\n')[0];
      console.error(`[pr] ${ws.name}: could not hand ${bead} back to the queue — ${why}`);
      return { ok: false, why, rearmed: null };
    }
    // And the queue that is not the tracker's — bc-xl7n.117. The write above is the whole
    // of "back in `bd ready`", and it is only half of "a session will open on it": the
    // advocate refuses a bead at `maxAttemptsPerBead` from its own counter, in memory,
    // which no tracker write can reach. A bead whose two windows died before anybody read
    // the diff comes back open, unclaimed and permanently unpickable, and the sentence
    // below used to say the opposite. See `rearm` for why an answer of yours is a fresh
    // commission rather than a third retry — and why this is the per-bead one and not
    // `forget`, which would re-arm every other bead in the repo as a side effect of
    // answering one card.
    //
    // After the reopen and never instead of it: a hand-back that bd refused leaves the
    // bead claimed by a session that is gone, and clearing the charges on a bead nothing
    // can dispatch anyway would be a write that only makes the log read better.
    return { ok: true, why: null, rearmed: advocates.rearm(ws.name, bead) };
  }

  /**
   * What the log line says about a hand-back that has actually been tried.
   *
   * The re-arm is on it only when it did something. `rearm` answers zero for the ordinary
   * case — a bead nothing had given up on, which is almost all of them — and a clause
   * about attempt counters on every one of those lines is how the one that matters stops
   * being read.
   */
  function handBackSaid(bead, back) {
    if (!bead) return 'there is no work bead to hand back';
    if (!back.ok) return `${bead} could NOT be handed back and is still claimed — ${back.why}`;
    const cleared = back.rearmed?.charges
      ? `, and its ${back.rearmed.charges} attempt charge(s) are cleared${
          back.rearmed.retired ? ` — it was retired at ${back.rearmed.cap} and nothing would have opened on it` : ''
        }`
      : '';
    return `${bead} is back in the queue${cleared}`;
  }

  /**
   * The same fact, for the card — and only where it changes what you are being told.
   *
   * A retired bead is the one case where the promise the card makes ("it is back in the
   * queue") was false, so it is the one case worth a clause on the phone. A bead with one
   * charge on it was never in trouble and does not need telling.
   */
  function rearmSaid(back) {
    return back.rearmed?.retired
      ? ` It had run out of attempts (${back.rearmed.charges} of ${back.rearmed.cap}), so those are cleared too — otherwise nothing would have opened on it.`
      : '';
  }

  async function resolveDeliveryFor(ws, id, response, { actor = null } = {}) {
    const none = { note: '', result: null, deploy: null };
    const act = deliveryAction(response);
    if (!act) return none;

    const issue = await bd.show(ws, id).catch(() => null);
    if (!issue) return none;
    const d = parseDelivery([issue.description, issue.design, issue.notes].filter(Boolean).join('\n\n'));
    if (!d) return none; // An ordinary question answered with something that looked like a marker.
    if (d.error) throw Object.assign(new Error(d.error), { status: 422 });

    const gh = await pr.available();
    if (!gh.ok) throw Object.assign(new Error(`cannot act on #${d.number}: ${gh.reason}`), { status: 503 });

    const { unit, dir } = await unitForDelivery(ws, d);

    if (act.action === 'merge' || act.action === 'ship') {
      const merged = await pr.merge(dir, d.number, { method: d.method, deleteBranch: true });
      const landed = merged.mergeCommit ? ` as ${merged.mergeCommit.slice(0, 8)}` : '';
      const was = merged.alreadyMerged ? 'was already merged' : `merged${landed}`;
      // Every other branch open on this base is now measured against a base it has never
      // seen, and some of them stop fitting — see lib/mergesweep.js. Recorded rather than
      // swept here, so this returns when the merge is done and not when a resolver window
      // has opened, and so a sweep that goes wrong cannot fail a merge that has landed.
      requestSweep({ workspace: ws.name, key: unit.key, number: d.number, base: d.base, why: `a delivery card in ${ws.name}` });
      // And the window that delivered it, told that it landed. This is the `--review`
      // door — a delivery that skipped the queue files no merge-bead, so lib/mergequeue.js
      // never sees this pull request and would never rename it. Before the close below,
      // for the reason `finish` gives: closing the work bead is what makes the window
      // reapable, and renaming after that races the signal that closes it.
      if (d.bead) {
        const renamed = describeMarked(markWindowMerged(cfg, d.bead));
        if (renamed) console.log(`[pr] ${ws.name}/${d.bead}: ${renamed}`);
      }
      // The work bead, not the question. Closing it here is what makes the merge the
      // end of the work rather than a step in it — and the reason names the PR,
      // because six months on the number is the only way back to the diff.
      // Attributed for the same reason `bd.respond`'s close is: one tap closes the
      // question and the work, and two names across them would read as two people.
      const finished =
        d.bead && d.bead !== id
          ? await finishWorkBead(ws, d.bead, id, `Merged #${d.number}${landed} into ${d.base}`, { actor })
          : null;
      console.log(
        `[pr] ${ws.name}: #${d.number} ${was} → ${d.base}, ` +
          (!finished ? 'no work bead named' : finished.closed ? `closed ${d.bead}` : `${d.bead} stays open — ${finished.why}`) +
          (merged.cleanup ? ` (gh could not tidy up: ${merged.cleanup})` : '')
      );
      bus.emit({ type: 'merged', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
      // What the card says happened has to be what happened. A refused close reported
      // as a close is how bc-ec6 ended up with two answers on two cards, each saying
      // it had closed a bead that was open the whole time — and reading either one
      // back tells you the work is finished when it is not. See lib/owed.js.
      const note =
        `Merged #${d.number}${landed}` +
        (!finished ? '' : finished.closed ? ` — closed ${d.bead}` : ` — **${d.bead} is still open:** ${finished.why}. It closes as soon as that clears`) +
        '.' +
        // Said, but said last and said small. `gh` failing to tidy the local branch
        // after the merge is the ordinary case here — the branch is checked out in the
        // worktree the work was done in — and the merge is untouched by it. It earns a
        // sentence rather than silence only because it is the one thing on this card
        // that did not go to plan, and lib/tidy.js is what eventually clears the branch.
        (merged.cleanup ? ` \`gh\` could not tidy up afterwards — ${merged.cleanup} — which leaves the local branch behind and the merge unaffected.` : '');
      if (act.action === 'merge') return { note, result: { action: 'merge', pr: merged }, deploy: null };

      // Ship: the merge has happened and is not undone by anything below. Everything
      // from here decides what the note says and whether `/api/respond` has a deploy
      // to start — and every failure is a sentence rather than a throw, because a
      // throw would leave the question open over a merge that already landed.
      const where = whereLanded(unit.workspace, unit.repo);
      let why = '';
      let plan = null;
      try {
        plan = deployFor(cfg, unit.key);
        if (!plan) why = `no deploy is declared for ${unit.key} — see \`deploys\` in ${CONFIG_PATH}`;
      } catch (err) {
        // A declaration that is present and malformed. Named on the card, because the
        // only person who can fix it is the one reading this.
        why = `${where} declares a deploy this cannot read — ${err.message}`;
      }
      const already = plan && !why ? runningFor(unit.key) : null;
      if (already) why = `a deploy of ${where} is already running (${already.id})`;

      if (why) {
        console.error(`[pr] ${where}: merged #${d.number} but will not deploy — ${why}`);
        return { note: `${note} **Not deployed:** ${why}.`, result: { action: 'ship', pr: merged, deploy: null }, deploy: null };
      }
      return {
        note: `${note} Deploying ${where} now — how it went lands on the PR board and on your phone.`,
        result: { action: 'ship', pr: merged, deploy: null },
        // The repo's key, which is what `startDeploy` takes. `workspace` stays on it too:
        // `/api/respond` logs it and the tracker a notification files on is still the graph.
        deploy: { key: unit.key, workspace: unit.workspace, bead: d.bead || null, reason: `Shipped #${d.number}${landed} from ${id}` },
      };
    }

    if (act.action === 'changes') {
      // Verbatim, both places. On the PR because that is where whoever opens the
      // diff will look for it, and on the bead because that is what the next
      // session reads before it starts.
      const note = act.note || `${ownerName(cfg)} asked for changes — see the bead.`;
      await pr.comment(dir, d.number, `**Changes requested**\n\n${note}`).catch((err) => {
        console.error(`[pr] ${ws.name}: could not comment on #${d.number} — ${err.message}`);
      });
      const bead = d.bead && d.bead !== id ? d.bead : null;
      if (bead) {
        // Yours. The heading is the daemon's wrapper, but `note` is verbatim what you
        // typed, and "who asked for changes" is the first thing the next session wants
        // to know. The hand-back below is not attributed: putting a bead back in the queue
        // is bookkeeping, like the `human-replied` label.
        await bd.comment(
          ws,
          bead,
          `## Changes requested on #${d.number}\n\n${note}\n\nThe branch \`${d.branch}\` is still open — push to it, do not start a new one.`,
          { actor }
        );
      }
      const back = await handBackWorkBead(ws, bead);
      console.log(`[pr] ${ws.name}: changes requested on #${d.number} — ${handBackSaid(bead, back)}`);
      // The sweep the board is cached from is now wrong about the row this changed, and
      // the boards that will come asking are the ones the event below is about to wake.
      // Dropped here rather than left to each of them sending `?refresh=1`: that would be
      // one `gh` sweep per open board where this is one for all of them. Same call and
      // the same reasoning as the merge path above.
      forgetBoard(dir);
      bus.emit({ type: 'changes', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
      return {
        // Honest here too, and for a reason the log line does not have: this sentence is
        // what lands on the phone. A hand-back that was refused means nothing is coming
        // back for the branch, and the one person who could do anything about that is the
        // one reading this card.
        note: back.ok
          ? `Changes requested on #${d.number} — ${bead || 'the work'} is back in the queue.${rearmSaid(back)}`
          : `Changes requested on #${d.number} — but ${bead} could **not** be put back in the queue (${back.why}), so nothing will pick it up. It needs releasing by hand.`,
        // `rearmed` beside it because they are two different questions with two
        // different answers: the tracker took the bead back, *and* the dispatcher will
        // offer it — see `handBackWorkBead`. Zero on almost every answer, which is what
        // it should be.
        result: { action: 'changes', handedBack: back.ok, rearmed: back.rearmed?.charges || 0 },
        deploy: null,
      };
    }

    /**
     * Decline: the approach was wrong, not the work.
     *
     * The PR closes and the branch is abandoned — but the bead is deliberately *not*
     * closed, because deciding against this attempt is not deciding against the work,
     * and quietly closing it would make it so. It is reopened and unclaimed instead,
     * which is what actually returns it to `bd ready`: it was claimed by the session
     * that built the branch, and a claimed bead never comes back. Without that the
     * bead would sit "open" forever, held by a session that has already exited.
     *
     * That last sentence is why this goes through `handBackWorkBead` (bc-36xx.17): the
     * paragraph above had it right about the session being gone, and then called the
     * reopen that bd refuses for exactly that reason. Same fix, same reason, same shape
     * as the changes path above — see the helper.
     *
     * The note is optional and is the most valuable sentence here. A decline with no
     * direction tells the next session only that its predecessor was wrong, which is
     * exactly enough information to do the same thing again — so where there is one,
     * it goes on the bead under a heading that says what it is.
     */
    const why = act.note || '';
    await pr.close(dir, d.number, {
      comment: why ? `**Declined** — ${why}` : 'Declined from beadcause: this approach is not the one.',
      deleteBranch: false,
    });
    const declined = d.bead && d.bead !== id ? d.bead : null;
    if (declined) {
      await bd.comment(
        ws,
        declined,
        [
          `## This approach was declined`,
          '',
          `[#${d.number}](${d.url}) was closed without merging, and \`${d.branch}\` is abandoned — do not push to it or reopen it.`,
          '',
          why
            ? `**The direction to take instead:**\n\n${why}`
            : '_No direction was given. Read the closed PR before starting again — whatever was wrong with it is not written down anywhere else._',
          '',
          'The bead is open again because the work still wants doing. Start from a fresh branch.',
        ].join('\n'),
        // Yours, and this is the note that most needs a name on it: a decline says
        // somebody's approach was wrong, and the next session should be able to see who
        // said so and go and ask them.
        { actor }
      );
    }
    const backFromDecline = await handBackWorkBead(ws, declined);
    console.log(
      `[pr] ${ws.name}: declined #${d.number}${why ? ' with direction' : ' with no direction given'} — ${handBackSaid(declined, backFromDecline)}`
    );
    // As above: one sweep for every board this wakes, rather than one each.
    forgetBoard();
    bus.emit({ type: 'pr-declined', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
    return {
      // As on the changes path: the card says what happened, not what was attempted.
      note: backFromDecline.ok
        ? `Declined #${d.number}${why ? ' with direction' : ''} — ${declined || 'the work'} is back in the queue.${rearmSaid(backFromDecline)}`
        : `Declined #${d.number}${why ? ' with direction' : ''} — but ${declined} could **not** be put back in the queue (${backFromDecline.why}), so nothing will pick it up. It needs releasing by hand.`,
      result: { action: 'decline', directed: Boolean(why), handedBack: backFromDecline.ok, rearmed: backFromDecline.rearmed?.charges || 0 },
      deploy: null,
    };
  }

  /**
   * Send a decision back to a branch a resolver handed back — the fourth answer that acts.
   *
   * lib/sweepcard.js files one card per conflict sweep, and until bc-9d37.8 the far end of
   * that loop was open. A resolver stops for exactly one reason — both sides are
   * load-bearing and only Adam can say which wins — the card names the pull request and
   * quotes what the session said, he reads it, types *take main's renderRow*, and nothing
   * read it. The next step was a Mac, a branch, and *Resolve conflicts*, which opens a
   * session with the ordinary brief knowing nothing about the decision he had just made.
   *
   * So this is that decision, delivered. It runs beside `createProposed`,
   * `resolveAmendmentFor` and `resolveDeliveryFor` and in the same place in the handler —
   * *before* the close — for their reason: a window macOS refuses to open must leave the
   * card answerable rather than closed on a promise nothing kept.
   *
   * **It has to be here and not in a worker or a script.** `resolveFor` keeps "one
   * resolver per pull request", the cap of two and the queue in module-global state, in
   * memory and never on disk, because a window handle is worth exactly as long as the
   * iTerm holding it. Any other process starts from an empty registry, cannot see the
   * window the daemon opened ten minutes ago, and opens a second one on the same branch —
   * which is bc-utyr. lib/server.js is the daemon, so all of that is free here.
   *
   * Three answers, and the middle one is the reason the two beads of this group were
   * worked together: a pull request with **no** live resolver gets a window whose brief
   * carries the sentence; one that **already has** a live resolver gets the sentence typed
   * into that window (`nudgeMessage`, the variant bc-9d37.6 added — without it that path
   * would have told a session Adam had pressed *Resolve conflicts* again, which is the
   * sentence this group exists to remove); one the Mac is **full** for is queued, and the
   * card says where in line.
   */
  async function resolveSweepFor(ws, id, response, { option = null } = {}) {
    const none = { note: '', result: null, bound: false };
    const rec = readSweepCards()[id];
    // Not a sweep card, or a record this daemon is not the one following. Every other
    // question in the inbox lands here and leaves by this line.
    if (!rec || rec.workspace !== ws.name) return none;

    const want = sweepAnswer(rec, response, option);
    if (!want) return none;

    const row = want.waiting.find((r) => Number(r.number) === want.number);
    // A number that is on the card but no longer waiting — answered twice, or answered
    // while the follow-up was amending. Said rather than silently done, because the
    // alternative is a second window on a branch somebody is already in.
    if (!row) {
      return {
        note: `**Nothing opened for #${want.number}:** it is not one of the ones waiting on you on this card any more.`,
        result: null,
        bound: true,
      };
    }
    if (!want.note) {
      return {
        note: `**Nothing opened for #${want.number}:** you tapped it but wrote no instruction, and a session opened without one would stop where the last one did.`,
        result: null,
        bound: true,
      };
    }
    // The same two refusals `/api/pr/conflicts` keeps, in its order and for its reasons: an
    // observer on a spare port shares these checkouts and may not open an unattended session
    // in a repo it is only visiting, and a daemon with windows switched off has none to open.
    if (OBSERVING) return { note: `**Nothing opened for #${want.number}:** ${OBSERVING_NOTE}`, result: null, bound: true };
    if (cfg.openSessions === false) {
      return { note: `**Nothing opened for #${want.number}:** \`openSessions\` is disabled in config.`, result: null, bound: true };
    }

    const { dir } = locate(cfg, rec);
    if (!dir) {
      return { note: `**Nothing opened for #${want.number}:** there is no checkout of ${rec.key} on this Mac any more.`, result: null, bound: true };
    }
    const unit = unitFor(cfg, rec.key);
    // The row as `conflictPromptFor` wants it. The record's beads are ids and the brief
    // reads `.id` off each, which is the one shape change between the two.
    const brief = {
      number: row.number,
      branch: row.branch,
      base: rec.base || configuredBase(cfg, unit?.workspace || ''),
      title: row.title || '',
      url: row.url || '',
      repo: rec.repo || '',
      repoName: unit?.repo?.name || null,
      beads: (row.beads || []).map((b) => ({ id: b })),
    };

    /**
     * Is there still a conflict to decide about? Asked of GitHub rather than of the card.
     *
     * The card's row is the last thing the follow-up saw, and for a row waiting on him
     * that is a quarter of an hour old at worst and a great deal older in practice: the
     * follow-up re-asks about one on `WAITING_RECHECK_MS` (bc-9d37.17), and what he is
     * tapping is a card his phone drew before that. So a branch somebody rebased by hand
     * five minutes ago still reads `handed-back` here, and a window opened for it is one
     * to go and close — the exact refusal `/api/pr/conflicts` makes before a tap opens
     * anything. Free at the moment of a tap, and the tap is rare.
     *
     * A `gh` that will not answer is not evidence either way, and Adam has just asked for
     * this: it goes ahead, and the brief's own step 4 finds a clean merge and says so.
     */
    let latest = null;
    try {
      latest = (await pr.mergeability(dir, row.number, { timeoutMs: 0 })).pr;
    } catch {
      latest = null;
    }
    if (latest && String(latest.state || '').toUpperCase() !== 'OPEN') {
      const was = String(latest.state).toUpperCase() === 'MERGED' ? 'merged' : 'closed';
      return { note: `**Nothing opened for #${row.number}:** it was ${was} since the sweep — there is no conflict left to decide.`, result: null, bound: true };
    }
    if (latest && latest.mergeable && latest.mergeable !== 'CONFLICTING' && latest.mergeable !== 'UNKNOWN') {
      return { note: `**Nothing opened for #${row.number}:** GitHub does not report a conflict on it any more.`, result: null, bound: true };
    }

    let outcome;
    try {
      outcome = await resolveFor(
        rec.key,
        row.number,
        () => openConflictSession(cfg, ws, brief, { dir, sweptAfter: rec.after, instruction: want.note }),
        {
          branch: row.branch,
          owner: ownerName(cfg),
          // Why this was asked, for the session that already has it. See `nudgeMessage`.
          sweptAfter: rec.after,
          instruction: want.note,
          // And the same question again at the moment a queued window would actually open,
          // which may be an hour from now — `resolveFor`'s own note on why every caller
          // that reaches GitHub should pass one.
          recheck: async () => {
            const { pr: now } = await pr.mergeability(dir, row.number, { timeoutMs: 0 });
            if (String(now.state || '').toUpperCase() !== 'OPEN') {
              return `#${row.number} was ${String(now.state).toUpperCase() === 'MERGED' ? 'merged' : 'closed'} while it waited for a window`;
            }
            if (now.mergeable && now.mergeable !== 'CONFLICTING' && now.mergeable !== 'UNKNOWN') {
              return `#${row.number} stopped conflicting while it waited for a window`;
            }
            return true;
          },
        }
      );
    } catch (err) {
      // iTerm refusing the Apple event, a checkout that has moved. A sentence and not a
      // throw: the card must stay answerable, and a 500 over a question that was
      // understood is one you answer again to get the same 500.
      return { note: `**Could not open a session on #${row.number}:** ${err.message.split('\n')[0]}.`, result: null, bound: true };
    }
    if (outcome.error) return { note: `**Could not open a session on #${row.number}:** ${outcome.error}.`, result: null, bound: true };

    const state = outcome.queued ? 'queued' : 'working';
    const said = outcome.queued
      ? `#${row.number} is in line for a window — ${outcome.note || 'the Mac is full'}`
      : outcome.reused
        ? `#${row.number} already had a session on it, so your answer went into that window`
        : `A session is on #${row.number} now, on \`${row.branch}\`, carrying your answer`;

    // The record first, then the card, and the card is what he is looking at. `chaseRow`
    // asks GitHub about a `handed-back` row only to find out whether it has ended, and a
    // branch a resolver is halfway through is a branch that still conflicts — so without
    // this the card would go on saying a session stopped on it while a session was working
    // on it, for as long as the work took.
    const next = markResolving(id, row.number, state, outcome.note || '');
    if (next) {
      await bd.update(ws, id, { description: sweepCardBody(next) }).catch((err) => {
        // The window is open and the record is right; the card is stale for one poll
        // cycle and `followSweepCards` amends it then. Never worth failing the answer.
        console.error(`[sweep] ${ws.name}: could not amend ${id} after answering #${row.number} — ${err.message.split('\n')[0]}`);
      });
    }
    console.log(`[sweep] ${ws.name}: ${id} answered #${row.number} — ${state}`);
    bus.emit({ type: 'resolving', key: `${ws.name}/${id}`, workspace: ws.name, id, number: row.number, state });
    return { note: `${said}. This card stays open and says how it goes.`, result: { number: row.number, state }, bound: true };
  }

  /**
   * Change what an agent is — and nothing else, ever.
   *
   * The mirror of `createProposed`, for the other question whose answer writes
   * something. An agent may ask to be different; only this can grant it, and only
   * from an answer that starts with the approval marker. Everything else is a
   * refusal, which is *also* written down: a declined request that leaves no trace
   * is one the agent has every reason to file again next week, having reasoned its
   * way back to the same conclusion from the same starting point.
   *
   * The re-seed is the last step and the one that makes this a loop rather than a
   * setting. Three of the four agent kinds re-seed themselves for free, because each
   * is a `claude` process that exits and reads the foundation again on its next
   * spawn. The console is the exception — it resumes a session — so it is restarted
   * explicitly.
   */
  async function resolveAmendmentFor(ws, id, response) {
    let dir;
    try {
      dir = resolveSessionDir(cfg, ws);
    } catch {
      // No directory means no repo means no foundations ref. An ordinary question in
      // a workspace like that is unaffected; an amendment question could not have
      // been filed there in the first place.
      return { note: '', result: null };
    }

    const outcome = await resolveAmendment(bd, ws, dir, id, response);
    if (outcome.declined) {
      const { agent, fields } = outcome.declined;
      console.log(`[beadcause] ${ws.name}: declined ${agent}'s request for ${fields.join(', ')} — recorded`);
      return { note: `Declined: ${displayName(agent)} keeps its ${fields.join(', ')}.`, result: outcome };
    }
    if (!outcome.amended) return { note: '', result: null };

    const { agent, fields } = outcome.amended;
    console.log(`[beadcause] ${ws.name}: AMENDED the ${agent} foundation — ${fields.join(', ')}`);

    // A chat session holds a session, so it has to be told. The others do not, and
    // saying so on the card is worth a line: "approved" and "in effect" are the same
    // moment here, and that is not obvious.
    let where = 'takes effect on its next run';
    if (agent === 'console') {
      const open = consolesFor(ws.name);
      for (const c of open) {
        reseedConsole(
          c,
          `${ownerName(cfg)} approved a change to what this chat session is (${fields.join(', ')}). ` +
            `Starting a fresh session on the new definition — this conversation stays on screen, ` +
            `but the agent is reading it for the first time.`
        );
      }
      where = open.length
        ? `${open.length} open chat session${open.length === 1 ? '' : 's'} re-seeded`
        : 'takes effect on the next chat session you open';
    }
    bus.emit({ type: 'amended', key: `${ws.name}/${id}`, workspace: ws.name, id, agent, fields });
    return { note: `Amended: ${displayName(agent)} ${fields.join(', ')} — ${where}.`, result: outcome };
  }

  /** One agent by id, from the same roster the phone was shown. */
  const roster1 = (id) => rosterNow().find((a) => a.id === id) || null;

  /**
   * What the dialog says before an agent is first elevated.
   *
   * Written here rather than in the client so every surface — the PWA, the Android
   * shell, anything later — warns in the same words about the same string. It names
   * the tools verbatim: a warning that will not tell you what is being granted is
   * theatre.
   */
  const disclaimerFor = (agent) => ({
    agent: agent.name,
    title: `Give ${agent.name} extended tools?`,
    tools: agent.tools,
    points: [
      `For one reply only. It is armed now and spent the moment you send your comment — it does not persist, and restarting the daemon disarms it.`,
      `${agent.name} runs unattended, as you, on this Mac. Nothing reviews what it does before it does it, and the reply arrives after the fact.`,
      `Its normal reach is read-only: read files, and the \`bd\` commands that only look. This grants exactly what is listed above and nothing else.`,
      `You cannot change this while it is answering something, and you will not be asked again for ${agent.name}.`,
    ],
  });

  /**
   * One bead, written to the tracker — the single `bd create` behind both doors a
   * *person* files a bead through.
   *
   * The doors are the chat console's accept button (`/api/console/create`, which calls
   * this once per card in the draft) and the create form on Home's `All Beads`
   * (`/api/bead/create`, which calls it once). They are two screens with one write
   * between them on purpose: bc-khoe.27.3 could have grown a second `bd create` of its
   * own with the same eight fields, and the two would then have been free to disagree
   * about any of them — which labels survive, where the declared surface goes, whether
   * `created_by` is stamped — with nothing saying which was right. There is one answer
   * here, and a field added to it is added to both screens at once.
   *
   * What it deliberately is **not** is `fileBeads` in lib/filing.js. That is the seam an
   * *agent* files through and it stamps what an agent-filed bead has to carry —
   * `unendorsed`, `agent-filed`, a `discovered-from` edge, and a note that opens "Filed
   * by an agent". None of that is true of a bead you typed yourself, and a bead you
   * filed from your own phone arriving held for your own endorsement is the sort of
   * nonsense that reads as a bug in the tracker rather than in this file.
   *
   * The parent is the caller's, already resolved: the console resolves a ref against the
   * beads it is creating in the same pass, and the form asks lib/homing.js. Neither
   * decision belongs to a function whose whole job is the write.
   */
  async function createBead(ws, b, { actor = null, parent = '', onWarn = () => {} } = {}) {
    // What the caller may actually say about a bead that does not exist yet. The six the
    // daemon owns are dropped here with a warning each rather than refused —
    // lib/proposedlabels.js has the whole argument, including why this is deliberately
    // *not* the same list `isProtectedLabel` refuses on an adjust. bc-xl7n.44.
    const proposed = filterProposedLabels(b.labels, { ref: b.ref || b.title });
    for (const w of proposed.warnings) onWarn(w);
    const id = await bd.create(
      ws,
      {
        title: b.title,
        // The declared surface rides *inside* the description, because bd has no field
        // for it and a `bd list --json` row carries the description for free
        // (lib/beadfiles.js, bc-42ow). `withSurface` is the only thing that spells the
        // block, here and in lib/filing.js both, so the console's beads and an
        // advocate's cannot come to declare a file differently. A bead that named no
        // file hands its description back untouched — and untouched literally, not
        // `withSurface(desc, [])`, whose empty case withdraws a block a person may have
        // typed into the description themselves. See the same guard and the whole
        // argument in `beadToIssue`, lib/filing.js.
        body: b.files?.length ? withSurface(b.description, b.files) : b.description,
        type: b.type,
        priority: b.priority,
        // Exactly the labels asked for — which is normally none. `bd.create` defaults to
        // `['human']` for /api/ask's benefit, and inheriting that here would file every
        // bead as a question and put the lot in your inbox waiting for an answer nobody
        // is asking for.
        labels: proposed.labels,
        acceptance: b.acceptance,
        design: b.design,
        notes: b.notes,
        parent: parent || '',
      },
      // You pressed the button; `created_by` records the press. `owner` is untouched, so
      // the bead queues exactly as any other does — see `actorFor`.
      { actor }
    );
    if (!id) throw new Error(`bd created "${b.title}" but returned no id`);
    return id;
  }

  function requireWorkspace(name) {
    const ws = workspaces.get(name);
    if (!ws) throw Object.assign(new Error(`unknown workspace: ${name}`), { status: 400 });
    return ws;
  }

  /**
   * The **repo** a request is about: `{ ws, unit }`, or a 400 saying which half is wrong.
   *
   * Everything that deploys, ships or lists pull requests is per repo now (bc-l853.6), and a
   * request names one with a key — `beadcause`, or `climative/athena-service`. `workspace` is
   * still accepted and still means what it always did, because for every workspace that is
   * one repo the key *is* the workspace's name: an old page in somebody's browser, a script,
   * a phone that has not reloaded its bundle all keep working unchanged, and the only callers
   * that must send a key are the ones acting on a workspace that holds several repos — where
   * there was no correct behaviour to be compatible with.
   *
   * A bare workspace name for a multi-repo workspace is therefore a 400 with `unitFor`'s own
   * sentence in it, which names a key that would have worked. Answering with the default repo
   * is the one thing it will not do: an unattended Ship that deploys the wrong service is not
   * improved by having been convenient.
   */
  function requireUnit(body = {}) {
    const asked = String(body.key || body.workspace || '').trim();
    if (!asked) throw Object.assign(new Error('a repo is required'), { status: 400 });
    const unit = unitFor(cfg, asked);
    const ws = workspaces.get(unit.workspace);
    if (!ws) throw Object.assign(new Error(`unknown workspace: ${unit.workspace}`), { status: 400 });
    if (unit.problem) throw Object.assign(new Error(unit.problem), { status: 400 });
    return { ws, unit };
  }

  /**
   * The checkout one unit is: the repo's own directory, or the workspace's.
   *
   * Throws `resolveSessionDir`'s 409 for a workspace this Mac cannot place, which is what
   * every caller here already expected of it. A unit with a repo cannot fail that way — it
   * would not be a unit if its directory had not resolved (`repoUnits`).
   */
  const checkoutOf = (unit) => (unit.repo ? unit.repo.dir : resolveSessionDir(cfg, workspaces.get(unit.workspace) || { name: unit.workspace }));

  /**
   * Where the requirements corpus is, from the server's point of view — bc-fvmx.
   *
   * Every workspace this daemon serves rather than one, because the server is not standing
   * in a repo the way a session is: the corpus lives in one checkout and the screen asking
   * about it is a phone. Null on an install that has no such checkout, which is the
   * ordinary state and what the route reports as `{ corpus: null }`.
   */
  function requirementsCorpus() {
    const dirs = [];
    for (const ws of workspaces.values()) {
      try {
        dirs.push(resolveSessionDir(cfg, ws));
      } catch {
        // A workspace this Mac cannot place is not a place a corpus could be either.
      }
    }
    for (const repos of Object.values(cfg.repos || {})) {
      for (const r of repos || []) if (r?.dir) dirs.push(r.dir);
    }
    return corpusDir(cfg, dirs);
  }

  /**
   * Which repos a ledger request is over — one, a space's worth, or all of them.
   *
   * The bead this was written for calls it "the ledger for a space", and the page that
   * draws it follows the same top-level picker every other view does. But a *space* is a
   * set of repos (`cfg.spaces[].workspaces`), so the two readings of "for a space" are
   * different requests, and both are real: the History tab as it is first drawn asks for
   * one repo at a time, and a space that spans three of them wants the three merged and
   * interleaved by date. So both parameters are accepted, `workspace` wins when both are
   * sent, and neither is required.
   *
   * The three refusals are deliberately different from each other:
   *
   * - an unknown `workspace` is a **400**, because a client naming a repo that is not
   *   configured is a client that is confused rather than one asking about an empty
   *   ledger — same as `/api/bead`;
   * - an unknown `space` is a **404**, matching `GET /api/space`, which is the route a
   *   space name would have come from in the first place;
   * - a *configured* space holding no configured workspace is neither. It is an empty
   *   ledger with a 200, because that is a true answer about a space someone has set up
   *   and not yet pointed at a repo.
   *
   * `Other` is the synthetic group the picker offers for repos in no space at all
   * (`summarise` in lib/spaces.js), and it is resolvable here for the same reason it is
   * drawn there: from the picker it is indistinguishable from a real space, so a tab
   * following the picker onto it must not 404.
   */
  const OTHER_SPACE = 'Other';
  function ledgerWorkspaces(params) {
    const asked = (k) => String(params.get(k) || '').trim();
    const wanted = asked('workspace');
    if (wanted) return { picked: [requireWorkspace(wanted)], workspace: wanted, space: '' };

    const space = asked('space');
    // "All" means all of *this account's* — the one place in this function where the
    // account is asked, because every other branch names a space or a workspace and the
    // picker that named it was already narrowed to the account.
    if (!space || space === 'all') return { picked: scopedWorkspaces(), workspace: '', space: space || 'all' };

    const configured = (cfg.spaces || []).find((s) => s.name === space);
    if (!configured && space !== OTHER_SPACE) {
      throw Object.assign(new Error(`no space called ${space}`), { status: 404 });
    }
    const assigned = new Set((cfg.spaces || []).flatMap((s) => s.workspaces || []));
    const names = configured
      ? configured.workspaces || []
      : (cfg.workspaces || []).map((w) => w.name).filter((n) => !assigned.has(n));
    // Through the map rather than trusting the config: a space may name a repo that has
    // since been dropped from `workspaces`, and sweeping a workspace that does not exist
    // would be an error over a stale line in a config file.
    return { picked: names.map((n) => workspaces.get(n)).filter(Boolean), workspace: '', space };
  }

  /**
   * The beads a verdict is aimed at — checked before any of them is written to.
   *
   * Every verdict takes one id or a list of them (see lib/verdict.js), and the checks
   * are the same four for all four, so they are here rather than copied into each
   * route. All of them happen *before* the first `bd` write: a group where the sixth id
   * is junk should be refused whole, not half applied and then reported.
   *
   * `BEAD_ID_RE` is the same guard `POST /api/session` uses, and for a weaker reason
   * here — these ids reach `execFile` and never a shell — but a body that names
   * `../../etc` is a client that is confused about what it is doing, and finding that
   * out on the request is better than finding it out in `bd`'s error text.
   */
  function verdictIds(body) {
    const ids = parseIds(body);
    if (!ids.length) return { error: 'id or ids is required' };
    if (ids.length > MAX_IDS) return { error: `${ids.length} beads in one verdict — ${MAX_IDS} is the most` };
    const bad = ids.find((id) => !BEAD_ID_RE.test(id));
    if (bad) return { error: `not a bead id: ${bad}` };
    return { ids };
  }

  /**
   * A JIRA ticket key off a request body, or `''` — the shape every JIRA key has ever
   * had, `TECH-1204`.
   *
   * The same job `BEAD_ID_RE` does above, for the routes that address a *ticket*
   * rather than a bead (bc-0i27.7). It matters more here than for a bead id, because a
   * cancel writes a record keyed on whatever it is given and nothing ever prunes one:
   * a body that named `../../etc` would leave an earmark nobody could tap to take back.
   */
  const jiraKey = (raw) => {
    const key = String(raw || '').trim();
    return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? key : '';
  };

  /**
   * Say what a verdict did — in the log, and to every phone that is parked on the poll.
   *
   * One event per bead rather than one per request, because the clients key everything
   * on `workspace/id` and a row that has just been endorsed or revoked is a row that
   * has to leave the queue on the other device too. The type is `endorsement` for all
   * four verdicts with the verdict itself alongside: a client watching the queue cares
   * that the bead moved, and one that does not care can ignore one type instead of
   * four.
   *
   * Failures are logged and not emitted. Nothing moved, so there is nothing to wake a
   * screen for — but the reason belongs in the log, since a group tap reports its
   * failures in a response the phone may well have navigated away from.
   */
  function announceVerdict(ws, out) {
    // The queue is cached for a few seconds (lib/endorsequeue.js) and a verdict has
    // just changed what is in it. Dropped here rather than left to the client's
    // `?refresh=1`, because the phone that acted is not the only one looking: a laptop
    // on its own poll would otherwise redraw a bead that is no longer waiting, and
    // tapping it would 409 over a list that was right when it was drawn.
    if (out.ok.length) forgetQueue();
    for (const r of out.ok) {
      bus.emit({ type: 'endorsement', verdict: r.verdict, key: `${ws.name}/${r.id}`, workspace: ws.name, id: r.id });
    }
    if (out.ok.length) {
      console.log(`[beadcause] ${out.verdict}: ${out.ok.map((r) => r.id).join(', ')} in ${ws.name}`);
    }
    for (const r of out.failed) {
      console.error(`[beadcause] could not ${out.verdict} ${ws.name}/${r.id} — ${r.error}`);
    }
  }

  /**
   * *"…and endorse bc-xl7n.121"* — the fourth thing an answer can do, and the last
   * surface the endorsement gesture reached.
   *
   * Adam answered a card twice, three days apart, by asking in the answer itself for a
   * **named other bead** to be endorsed. Both times the sentence was recorded as prose,
   * both times the card closed, and both times `unendorsed` stayed exactly where it was
   * — so bc-xl7n.121, the class fix for ten pull requests held by the stale-check gate,
   * sat one label away from dispatch for three days with every screen showing the
   * question as settled.
   *
   * lib/endorseanswer.js is the reading and holds the whole argument for reading prose
   * at all; this is the act. It runs through `applyVerdict` and `announceVerdict` rather
   * than calling `endorse` directly, and that is the point of it: those two are what
   * `/api/bead/endorse` runs, so a bead endorsed from an answer leaves the queue on
   * every device at the same moment, by the same event, as one endorsed from the
   * `/endorse` page. A second, quieter endorsement path is exactly what lib/endorse.js
   * warns against.
   *
   * Same workspace as the card, always. The reading is prefix-scoped (see there), so an
   * id under another workspace's prefix is never seen — and `requireWorkspace` is what
   * every other write in this handler is bounded by.
   *
   * `stuck` is the half the caller has to act on: an answer that named an endorsement
   * `bd` refused must not be recorded as settled, or the marker is still on and the
   * card is gone, which is the exact ending this exists to make unreachable.
   */
  async function resolveEndorsementsFor(ws, id, response) {
    const read = endorsementsIn(response, { prefix: prefixOf(id) });
    if (!read.endorse.length && !read.declined.length && !read.dropped.length) {
      return { note: '', stuck: false, read, result: null };
    }
    let out = null;
    if (read.endorse.length) {
      out = await applyVerdict(bd, ws, { verdict: 'endorse', ids: read.endorse });
      announceVerdict(ws, out);
      // The endorsement queue's own cache is dropped by `announceVerdict`; this is the
      // layer above it, for the same reason `/api/respond` drops it after every write.
      cacheDrop(`questions:${ws.name}`);
    }
    return { note: endorsementNote(read, out), stuck: Boolean(out?.failed?.length), read, result: endorsementResult(read, out) };
  }

  /**
   * The workspace and *checkout* an agent screen should act on.
   *
   * Two traps, both worth naming. `ws.dir` is the beads database
   * (`~/beads/<repo>/.beads`), not the repo — foundations live on a ref in the code
   * checkout, so this resolves the session directory the way every agent spawn does.
   * And an unnamed workspace falls back to the first configured one rather than to
   * `process.cwd()`, because the daemon runs from wherever launchd started it, which
   * is not a repo anyone has ever amended.
   */
  function agentTarget(name) {
    const ws = name ? requireWorkspace(String(name)) : cfg.workspaces[0];
    if (!ws) throw Object.assign(new Error('no workspaces are configured'), { status: 400 });
    return { ws, dir: resolveSessionDir(cfg, ws) };
  }

  /**
   * One row of the PR board, by workspace and number — what the three buttons act on.
   *
   * Deliberately resolved *through the board* rather than by a fresh `gh pr view`: a
   * button may only act on something the board is showing, so a phone left open
   * overnight cannot merge a pull request that has since scrolled out of the window
   * it was reading, and every action carries the same `pushed`/`deployed` facts the
   * row was drawn with. `force` is what keeps that safe rather than merely tidy — an
   * acting call re-sweeps, so the state it checks is seconds old, not as old as the tab.
   */
  async function prBoardRow(unit, number, { force = false } = {}) {
    if (!Number.isInteger(number) || number <= 0) {
      throw Object.assign(new Error('a pull request number is required'), { status: 400 });
    }
    const board = await collectBoard(bd, cfg, { force });
    if (board.unavailable) throw Object.assign(new Error(board.unavailable), { status: 409 });
    // By key: a number is only unique within a repo, so two Climative services both have a
    // #1 and a lookup by workspace would answer with whichever card sorted first.
    const card = pickCard(board, { key: unit.key });
    if (card?.error) throw Object.assign(new Error(card.error), { status: 409 });
    const row = (card?.prs || []).find((r) => r.number === number);
    if (!row) throw Object.assign(new Error(`no pull request #${number} on the ${unit.key} board`), { status: 404 });
    return row;
  }

  /** Only hand back files under an allow-listed root, and only viewable types. */
  async function assetPath(raw) {
    let p = String(raw || '');
    if (p.startsWith('file://')) p = fileURLToPath(p);
    p = path.resolve(p);
    let real;
    try {
      real = await fsp.realpath(p);
    } catch {
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    const allowed = assetRoots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!allowed) throw Object.assign(new Error('path not in assetRoots'), { status: 403 });
    if (!SERVABLE_EXT.has(path.extname(real).toLowerCase())) {
      throw Object.assign(new Error('unsupported file type'), { status: 415 });
    }
    return real;
  }

  /* ------------------------------------------------------------ signing in */

  /**
   * Whether Google sign-in is on, asked at most every 30 seconds.
   *
   * Cached because the answer costs two `stat`s and possibly a file read (lib/auth.js
   * → `certificateName`, `clientSecretFile`), and it would otherwise be asked on every
   * request including a 25-second poll from every open tab. Cached only *briefly*
   * because both inputs move under a running daemon: `listen()` fetches the
   * certificate seconds after `createApp` returns, and `npm run configure` rewrites
   * the config while the process lives. A 30-second window means "switched sign-in on"
   * takes effect without a restart, which is the behaviour anybody would assume.
   *
   * **This one is deliberately not on lib/cache.js, and that is bc-1kwl.3's answer rather
   * than an omission.** It was the fifth of the five that bead set out to convert; the
   * other four are converted and this is the argument for leaving it, written here
   * because the next person to read the bead will read this line first.
   *
   * Three reasons, and the third is the one that decides it.
   *
   * 1. **There is nothing to win.** Every other caller on the layer produces its value by
   *    spawning `bd` or `gh` — seconds, sometimes a minute. This producer is two `stat`s
   *    and possibly one small file read, and it is *synchronous*. Stale-while-revalidate
   *    exists to stop a request waiting on a subprocess; there is no wait here to remove.
   * 2. **It would cost the request path.** `cache.read` is async and `authNow()` is not,
   *    and it is called from the front of request handling. Making it a promise ripples
   *    into every caller of a function whose whole job is to answer one synchronous
   *    question before anything else happens.
   * 3. **Serving a kept authorisation answer past its window is a security decision.**
   *    That is bc-1kwl.2's own words and it is right. Today the thirtieth second is a
   *    hard edge: the answer is recomputed, from the config as it is now. On the layer it
   *    would become "hand back the old answer and go and look" — which for "is sign-in
   *    on?" means a window, of no fixed length, in which the daemon answers out of a
   *    config that has since been rewritten. Nobody should acquire that by tidying, and
   *    `secretFileWarning` below is on the same cadence for the same reason.
   *
   * So the window stays 30 seconds and stays a hard edge, and this stays six lines of
   * arithmetic rather than a caller of a layer built for a different problem.
   */
  let authCache = { at: 0, value: null };
  function authNow() {
    const now = Date.now();
    if (now - authCache.at < 30000) return authCache.value;
    const value = googleAuth(cfg);
    // Said on the same cadence as the reason sign-in is off, and for the same reason:
    // a `clientSecretFile` inside the config repo that the snapshotter does not refuse
    // is a leak waiting for the next write, and it is invisible from the app. Nothing is
    // switched off over it — see `secretFileWarning` — so this line is the only tell.
    const risk = value ? secretFileWarning(cfg) : null;
    if (risk && risk !== authCache.risk) console.warn(`[auth] ${risk}`);
    if (!value) {
      const why = googleProblem(cfg);
      // Once per window rather than per request, and only when something was clearly
      // *meant* to be configured: an install that never asked for sign-in must not be
      // told off about it every thirty seconds.
      if (why && why !== authCache.why) console.warn(`[auth] Google sign-in is off — ${why}`);
      authCache = { at: now, value: null, why, risk };
      return null;
    }
    authCache = { at: now, value, risk };
    return value;
  }

  /** Does this request carry the shared token? The first question asked, always. */
  const hasToken = (req, url) =>
    timingSafeEqual(req.headers['x-beadcause-token'] || url.searchParams.get('t'), cfg.token);

  /**
   * The signed-in devices, in `state.json` — so one of them can be ended without
   * ending the rest. See lib/devices.js for the whole of why.
   */
  const devices = createDeviceStore();

  /**
   * The signed-in session on this request, or null.
   *
   * `sessionKey()` reads a file, so it is resolved once per process rather than per
   * request — the key never changes under a running daemon, and deleting it (the
   * global revocation, which ends every device at once) is meant to take a restart or
   * a swap.
   *
   * **A valid signature is no longer sufficient, and that is the point.** The payload
   * names a row in the device list, and a cookie whose `sid` is not in that list is
   * refused: that is what makes revoking one device real, and it is what makes signing
   * out mean something — before this, `/auth/signout` cleared the cookie in the
   * browser that asked and the value stayed good for thirty days. A cookie with no
   * `sid` at all is one issued before the list existed; it is refused for the same
   * reason, because a live session the list cannot show is exactly the thing the list
   * exists to rule out. The cost is one sign-in, once.
   *
   * The `touch` is what makes "last seen" true, and it writes at most once every five
   * minutes per device — see SEEN_MS. Nothing here is on the path of a token caller:
   * this function is only reached by a request that had no token.
   */
  let sigKey = null;
  function sessionOf(req) {
    if (!authNow()) return null;
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    sigKey = sigKey || sessionKey();
    const payload = verifySigned(raw, sigKey);
    if (!payload) return null;
    if (!payload.sid || !devices.live(payload.sid)) return null;
    devices.touch(payload.sid);
    return payload;
  }

  /**
   * Who to write this request's bead as — the signed-in address, or null for
   * "beadcause", which is what `Bd` falls back to.
   *
   * Sign-in gave a browser an identity (lib/auth.js) and nothing used it: every
   * answer, comment and dismissal note went onto a bead as `beadcause`, so a thread
   * read six months later could not say whether it came from a phone, from the shared
   * token, or from an agent. This is the half that says.
   *
   * **The session wins over the token, and that is the deliberate answer for token
   * callers.** They are not losing anything: a token *with* a session cookie is a
   * browser you signed into — and the phone's app sends its stored token on every
   * fetch, so the other order would mean the attribution never once applied to the
   * device it was built for. A token with **no** cookie is every caller that cannot
   * hold one — an ntfy action button, lib/notify.js calling back, the Android shell,
   * scripts/shot.mjs, `curl`, the router's proxy hop — and every one of them lands
   * here on null and writes exactly the argv it always did.
   *
   * **What a person says or decides is attributed; what the daemon does around it is
   * not.** bc-vq21 drew that line at the answer, the comment and the dismissal note,
   * and left two categories open on purpose. bc-5l8s settled both, and they went the
   * same way:
   *
   *   - **The beads a "yes" files** — `/api/ask`, `/api/console/create`, and an
   *     approved advocate proposal. Held back before on the belief that `--actor` set
   *     a bead's `owner`, which is read as *whose queue this is* by `bd ready` and by
   *     the agents list here. It does not: `--actor` writes `created_by`, and `owner`
   *     comes from the git identity of the directory bd runs in, untouched by the flag
   *     and by BEADS_ACTOR. So the objection was to something that does not happen,
   *     and what is left is a byline on a bead you filed. `test/attribution.mjs` files
   *     one bead each way through the *real* bd and asserts the owner is identical and
   *     both are still ready — because that is the fact the decision turns on, and a
   *     fake `bd` cannot hold it honest.
   *   - **A pull request's verdict** — the "Changes requested on #N" and "This approach
   *     was declined" notes on the work bead, and the close reason on a merge. The
   *     wrapper around them is the daemon's, but the direction inside is verbatim what
   *     you typed, and "who asked for changes" is the sentence a next session most
   *     wants a name on. The merge close is attributed for the same reason `respond`'s
   *     close is: one tap closes the question and the work, and two names would read as
   *     two people.
   *
   * What stays `beadcause` is everything that is bookkeeping rather than a sentence:
   * labels, statuses, the reopen-and-unclaim that puts a bead back in the queue, the
   * `bd dep add` calls behind a console create, and the daemon's own note about a
   * create that failed half way. Same test that pins the `human-replied` label as the
   * daemon's pins those.
   *
   * The GitHub half of a verdict is out of scope and unchanged: `gh pr comment` posts
   * as whoever `gh` is authenticated as on this Mac, which no flag here can alter.
   */
  const actorFor = (req) => sessionOf(req)?.email || null;

  const redirect = (res, location, headers = {}) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };

  /**
   * The query parameters this daemon reads off a page request, which are the only ones
   * that may stay in a real query string when a path hops to a view.
   *
   * `t` is the pairing token — an ntfy action button and a home-screen shortcut both
   * arrive with it, `hasToken` above reads it off `url.searchParams`, and half the
   * pages in public/ read it again to put in `localStorage`. A hop that swept it into
   * the hash would drop it on the floor twice over: a fragment is never sent to a
   * server, so the second navigation would be a login screen.
   */
  const DAEMON_QUERY = new Set(['t']);

  /**
   * Where an address that names a **view** has to send a browser (bc-khoe.30.7).
   *
   * The views are panes of one document now (bc-khoe.30, and the shell note at the top
   * of public/index.html), so `/history` is not a page any more — it is `/` with
   * `#history` on it. The paths still have to work: they are on the phone's home screen,
   * in the Android shell's history and in notifications this daemon sent months ago, and
   * a bookmark that 404s is a worse outcome than nine names for one view.
   *
   * **It has to be a hop and cannot be a rewrite.** Every other short name in
   * `serveStatic` rewrites `urlPath` and the browser never finds out — which works
   * exactly because the thing being chosen is a *file*. A pane is chosen by the hash,
   * a hash is never sent to a server, and so serving `index.html` at `/history` would
   * load the shell with an empty hash: Home, built first and shown, whatever was tapped.
   * The 302 is the only shape that puts the fragment on the address bar, and it is
   * better than a rewrite would have been even if a rewrite could have worked — after
   * the hop the URL says which view is up, and what you send somebody is the screen you
   * are looking at.
   *
   * **The query string splits in two, and that is the only fiddly part.** A filter that
   * used to live in `location.search` lives in the hash's own query now (decision 5 in
   * public/hashroute.js: `/#history?status=closed`), because in one document a search
   * string outlives the view that wrote it. But `?t=` is not the view's, it is this
   * server's, and it has to stay where a server can read it. So everything the daemon
   * reads stays in front of the `#` and everything else goes behind it, which is why
   * `/closed?t=…` comes back as `/?t=…#history?status=closed` rather than as either
   * half alone.
   *
   * `narrow` is what the door itself decides, applied last so it overrules what arrived:
   * `/closed?status=open` is a contradiction and the name of the door is the half of it
   * that is not a typo.
   *
   * public/sw.js answers the same paths with the same hops when there is no daemon to
   * ask — see `VIEW_HOPS` there, which test/pagealias.mjs holds against this run of
   * `if`s so the two cannot drift.
   */
  const viewHop = (view, url, narrow, scope) => {
    const kept = new URLSearchParams();
    const filters = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(url.search || '')) {
      (DAEMON_QUERY.has(k) ? kept : filters).append(k, v);
    }
    for (const [k, v] of narrow || []) filters.set(k, v);
    const search = kept.toString();
    const query = filters.toString();
    /* `scope` is the fourth thing a hop can carry, and only one caller has one to give
       (bc-xnj67). The sixteen page aliases do not: `/history` has never named a space, and
       inventing one for it would narrow a page that has always meant "whatever you last
       picked". `/v/<ws>/<id>` is the exception — it names its workspace in the address, so
       it can land you scoped to that workspace instead of throwing the fact away. */
    const where = scope || '/';
    return `${where}${search ? `?${search}` : ''}#${view}${query ? `?${query}` : ''}`;
  };

  /**
   * Whether this navigation has to sign in first — the `Location` to send it to, or
   * `null` if it may go where it asked.
   *
   * The block at the foot of `serveStatic` is what normally asks this, and it keys on
   * `rel.endsWith('.html')`: the *file* a path resolves to. A path that **hops** resolves
   * to no file at all and so never reaches it (bc-khoe.30.7).
   *
   * Leaving them out would not let anybody in — the far end of every hop is `/`, and `/`
   * is gated by that same block — but it would quietly change what signing in *does*.
   * Every one of these sixteen addresses was a `.html` until this bead, so a signed-out
   * phone tapping its `/prs` shortcut used to be asked to sign in and then handed the
   * board. Hopped ungated it is asked at `/` instead, with `next=/`, and comes back to
   * Home — the hash naming the view having died with the navigation to the login screen.
   * That is the exact population these addresses exist for, so the hop asks first and
   * carries the address it was actually given.
   */
  const hopGate = (req, url) => {
    const auth = authNow();
    if (!auth) return null;
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    sigKey = sigKey || sessionKey();
    if (hasToken(req, url) || sessionOf(req) || paired(req, sigKey)) return null;
    return `/login?next=${encodeURIComponent(url.pathname + (url.search || ''))}`;
  };

  /**
   * `/auth/*` — the only routes on this server that are not behind a credential,
   * because they are how you get one.
   *
   * What they give away to an unauthenticated caller is deliberately nothing: whether
   * sign-in is configured, and — to a caller that already holds the cookie — the
   * address inside it. Not the client id, not the allowlist, not whether a given
   * address is on it. A refused address is told it was refused and nothing more.
   */
  async function serveAuth(req, res, url) {
    const p = url.pathname;
    const auth = authNow();

    // What the pages ask before they decide between a login redirect and the token
    // prompt. Unauthenticated on purpose: a page with no credential at all is exactly
    // the caller that needs the answer.
    if (p === '/auth/whoami') {
      const session = sessionOf(req);
      return json(res, 200, {
        google: Boolean(auth),
        signedIn: Boolean(session),
        email: session?.email || null,
        // So a page holding a working token does not send you to a login screen you
        // do not need.
        token: hasToken(req, url),
        /**
         * Who this *Mac* says it is — `cfg.me`, the handle lib/addressee.js addresses
         * questions to and lib/ownership.js stamps on a root.
         *
         * Not the same as `email` above and deliberately offered alongside it. That one
         * is whoever is signed into this browser, which on a phone borrowed at a desk is
         * not necessarily the person whose laptop is running the daemon. The bead sheet
         * offers both as one-tap suggestions and lets the thumb decide, rather than
         * guessing — a root stamped with the wrong owner is worse than one left unowned,
         * because the second is a state the triage can see and the first reads as decided.
         *
         * `null` on every install that has never set `me`, which is what makes the sheet
         * draw no suggestion there rather than a button that writes an empty label.
         */
        me: meHandles(cfg)[0] || null,
      });
    }

    if (p === '/auth/signout') {
      // Both methods. A POST is what the app sends; a GET is what a link in the login
      // page is, and the worst a forged one can do is sign you out — which is not a
      // consequence worth making unlinkable.
      //
      // The session is *revoked* as well as cleared, which it was not before: clearing
      // a cookie is a request to a browser, and the value it threw away stayed valid
      // for its full thirty days wherever else it had been copied. Now signing out is
      // the same act as revoking this row from another device, and reaches the same
      // list. See lib/devices.js.
      const here = sessionOf(req);
      if (here?.sid && devices.revoke(here.sid)) console.log(`[auth] signed out ${here.email}`);
      const secure = secureCookies(auth);
      const cookies = [clearCookie(SESSION_COOKIE, { secure }), clearCookie(FLIGHT_COOKIE, { secure })];
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookies, 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true }));
      }
      return redirect(res, '/login', { 'set-cookie': cookies });
    }

    if (!auth) return json(res, 404, { error: 'Google sign-in is not configured' });

    if (p === '/auth/google') {
      const { url: to, cookie } = beginSignIn(auth, { next: url.searchParams.get('next') });
      return redirect(res, to, { 'set-cookie': cookie });
    }

    if (p === CALLBACK_PATH) {
      const secure = secureCookies(auth);
      // The flight cookie is spent whatever happens next — it is a one-shot, and
      // leaving a live nonce in the browser after a failure is the one way this dance
      // can be replayed.
      const spent = clearCookie(FLIGHT_COOKIE, { secure });
      const fail = (reason, code) => {
        console.warn(`[auth] sign-in refused — ${reason}`);
        return redirect(res, `/login?error=${encodeURIComponent(code)}`, { 'set-cookie': spent });
      };

      // Google's own refusal — the consent screen was cancelled, or the client is
      // misconfigured at their end. It arrives here as a query parameter, not an error.
      if (url.searchParams.get('error')) return fail(`Google said ${url.searchParams.get('error')}`, 'cancelled');

      const flight = verifySigned(parseCookies(req.headers.cookie)[FLIGHT_COOKIE] || '', (sigKey = sigKey || sessionKey()));
      if (!flight) return fail('no sign-in was in flight (the cookie is missing or expired)', 'expired');
      if (!safeEqual(url.searchParams.get('state'), flight.nonce)) return fail('state did not match the cookie', 'state');

      const code = url.searchParams.get('code');
      if (!code) return fail('no code came back', 'nocode');

      const { idToken, error } = await exchange(auth, { code, verifier: flight.verifier });
      if (error) return fail(error, 'exchange');

      const { claims, error: claimError } = claimsOf(idToken, { clientId: auth.clientId, nonce: flight.nonce });
      if (claimError) return fail(claimError, 'claims');

      // The refusal that has to be logged, because it is the only signal that somebody
      // outside the allowlist got as far as Google and back. The address is in the log
      // and not on the screen: the person holding the browser already knows which
      // account they picked, and echoing it back is how a login page becomes a way to
      // find out whether an address exists.
      if (!emailAllowed(auth, claims.email)) {
        console.warn(`[auth] refused ${claims.email} — not on the allowlist`);
        return redirect(res, '/login?error=notallowed', { 'set-cookie': spent });
      }

      // The session is written down before the cookie is handed over, and a write that
      // fails is a refused sign-in rather than a cookie the very next request would
      // turn away with nothing on the screen to say why.
      const sid = newDeviceId();
      const { cookie: session, exp } = sessionCookie(auth, { ...claims, sid }, sigKey);
      try {
        devices.remember({ id: sid, email: claims.email, label: deviceLabel(req.headers['user-agent']), exp });
      } catch (err) {
        return fail(`could not write the device list — ${err.message}`, 'nodevice');
      }

      console.log(`[auth] signed in ${claims.email} on ${deviceLabel(req.headers['user-agent'])}`);
      return redirect(res, safeNext(flight.next), { 'set-cookie': [spent, session] });
    }

    return json(res, 404, { error: 'no such auth route' });
  }

  async function serveStatic(req, res, url, urlPath) {
    /**
     * `/v/<workspace>/<id>` and its assets — the one family of paths served from outside
     * `public/`.
     *
     * Deliberately the first thing in this function and deliberately *not* one of the
     * aliases below: those choose a file in this repo, and this chooses a file in
     * somebody else's. Keeping the two runs apart is what stops a future alias being
     * written in a shape that would let a repo name one of ours, and it is why the
     * one-line rewrites below — which lib/pagealias.js reads out of this file as a table,
     * by matching an equality against a quoted path — cannot see this block.
     *
     * Do not restate that pattern literally in prose anywhere inside this function.
     * `serveStaticAliases` in bin/b7e-owes.js scans this whole block, comments and all,
     * so a *comment* quoting the shape mints an alias that does not exist and the registry
     * gate then asks where its PAGES entry is. This paragraph used to do exactly that.
     *
     * Two shapes:
     *
     *   `/v/<ws>/<id>`               a navigation, hopped to `#<ws>.<id>` like /history
     *   `/v/<ws>/<id>/asset/<rel>`   one file out of that repo's `.beadcause/`
     *
     * The asset half is **ungated**, exactly like `/app.js` and `/style.css`, and for the
     * reason the block at the foot of this function gives: a `<script src>` carries no
     * token, a document is the only thing a person navigates to, and gating an asset
     * breaks an installed PWA in ways that look nothing like "please sign in". What it
     * serves contains no data — the payload arrives later through `/api/views/…/data`,
     * behind the same credential as everything else.
     *
     * `resolveAsset` is what makes that safe rather than merely conventional: every path
     * is resolved and re-checked against the resolved `.beadcause/` prefix, through
     * `realpath`, so neither a parent-directory step nor a symlink can name anything
     * outside it. See the trust-boundary note at the top of lib/repoviews.js.
     */
    if (urlPath === '/v' || urlPath.startsWith('/v/')) {
      /* Inside a `try`, because `decodeURIComponent` throws on a lone `%` — which is to
         say, on a URL somebody hand-edited or a crawler invented. The same care
         `parse` takes in public/hashroute.js, and for the same reason: a malformed
         address must be a 404 and not an exception out of the request handler. */
      let seg;
      try {
        seg = urlPath.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      if (seg.length === 2) {
        const signIn = hopGate(req, url);
        if (signIn) return redirect(res, signIn);
        /* Scoped to the workspace that declared the view (bc-xnj67). This is the one hop
           with a workspace in the address it was given, so it is the one that can land you
           somewhere narrower than "whatever you last picked" without inventing anything.
           A workspace in no configured space has no slug to write and falls back to `/` —
           the address still works, it is simply unscoped, which is what it was before. */
        const space = spaceFor(cfg, seg[0]);
        const scope = space ? `/${SCOPE_ROOT}/${encodeURIComponent(spaceSlug(space.name))}/${encodeURIComponent(seg[0])}` : '';
        return redirect(res, viewHop(repoviews.viewId(seg[0], seg[1]), url, null, scope));
      }
      if (seg.length > 3 && seg[2] === 'asset') {
        const view = repoviews.findView(cfg, scopedWorkspaces(), repoviews.viewId(seg[0], seg[1]));
        if (!view) return json(res, 404, { error: 'no such view' });
        // Only the two files the manifest actually declared. A view directory may hold
        // anything — a generator, a fixture, notes — and "inside `.beadcause/`" is a
        // weaker claim than "this view said this was one of its files". The manifest is
        // the allowlist, the way `approved` is in lib/repos.js.
        const rel = seg.slice(3).join('/');
        if (rel !== view.script && rel !== view.style) {
          return json(res, 404, { error: 'that view declares no such asset' });
        }
        const found = repoviews.resolveAsset(cfg, seg[0], rel);
        if (found.problem) return json(res, 404, { error: found.problem });
        try {
          const file = await repoviews.readAsset(found.full);
          res.writeHead(200, {
            'content-type': MIME[path.extname(found.full).toLowerCase()] || 'application/octet-stream',
            'content-length': file.size,
            // `no-cache` rather than a max-age, like every other asset here that is not
            // vendored: a repo view changes when its repo does, which is often, and a
            // phone holding last week's board because a header said it could is the one
            // failure this whole feature exists to end.
            'cache-control': 'no-cache',
          });
          return res.end(file.body);
        } catch (err) {
          return json(res, 404, { error: err.message });
        }
      }
      return json(res, 404, { error: 'not found' });
    }
    /* The run of one-line `if`s below is **read as a table** as well as run: lib/pagealias.js
       regexes it out of this file so the browser checks can serve the same aliases from their
       own fixtures, and `test/pagealias.mjs` fails the repo if the parse comes back empty or
       if a path in the service worker's SHELL has nothing to serve it. Write a new alias in
       one of the two shapes already here — the one-liner, or the braced form `/endorse` uses
       — and nothing has to be told about it twice. */
    // /doc?p=… is the reader tab. It's a static page: it pulls the token from
    // localStorage and fetches the file itself, so no token rides in the URL.
    if (urlPath === '/doc') urlPath = '/doc.html';
    if (urlPath === '/graph') urlPath = '/graph.html';
    // The sessions view is the advocate console now — it was two renderings of one
    // `/api/work` payload, and the console answers "what is running" per repo, which is
    // the way you arrive at the question. All three of its paths are kept and pointed at
    // it: they are on the phone's home screen and in the Android shell's history, and a
    // bookmark that 404s is a worse outcome than five paths for one page. `/work.html`
    // is in the list because the file behind it is deleted — it used to resolve as a
    // file on disk, and without this line it is the one path that breaks.
    //
    // A **hop** rather than a rewrite since bc-khoe.4 filled the Advocates container: the
    // console is a pane of the shell now, and `viewHop` above says why a rewrite cannot
    // do this — serving the shell under these paths would draw Home, because a hash is
    // never sent to a server.
    if (urlPath === '/work' || urlPath === '/sessions' || urlPath === '/work.html') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('advocates', url));
    }
    // One live session, addressed by pid — the detail every session row in the app
    // links to, and the drawer's third page after /graph and /doc. Static for the same
    // reason /doc is: it takes the token from localStorage and asks
    // /api/session-log itself, so no token rides in a URL that gets shared or pasted.
    if (urlPath === '/session') urlPath = '/session.html';
    // And the same detail for a session that has **finished**, addressed by bead rather
    // than by pid — a process id stops identifying anything the moment the process exits,
    // and this is the page you reach from a bead that closed in June. `/archive` too,
    // because "the archive" is what the thing is called everywhere else in the app and in
    // `git log refs/beadcause/sessions/…`; which of the two words comes to mind depends on
    // whether you arrived from a bead or went looking for the log.
    if (urlPath === '/bead-session' || urlPath === '/archive') urlPath = '/beadsession.html';
    // The chat session, with or without an id in the query.
    if (urlPath === '/console') urlPath = '/console.html';
    // The PR board, which is a pane on the advocates page now rather than a page of its
    // own (bc-d4d5) — so all three of its paths land there and public/montabs.js reads
    // the path and puts the PRs chip up. The same three are the PRs pill's `paths` in
    // public/viewbar.js, so the row marks it current on all of them (bc-khoe.1). `/pulls` because GitHub calls that tab Pull
    // requests and half the time that is the word you will reach for; `/prs.html` for
    // the reason `/work.html` is above it, that the file behind it is deleted and
    // without this line it is the one path of the three that breaks.
    //
    // **These three narrow, and they are the only paths here that do.** They mean the
    // *board*, not merely the view it is a chip of — and once the hop has happened there
    // is no pathname left for public/montabs.js to read them off. That is exactly what
    // its `tab=` slot in the hash was built for (bc-khoe.4): the chip travels behind the
    // `#`, the way `/closed` carries `status=closed` below.
    if (urlPath === '/prs' || urlPath === '/pulls' || urlPath === '/prs.html') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('advocates', url, [['tab', 'prs']]));
    }
    // The endorsement queue — the beads an agent filed that nobody has looked at yet.
    // Three paths because the screen has two honest names: it is the place you
    // *endorse* things, and it is the *queue* of what is waiting, and which word comes
    // to mind depends on whether you arrived from a notification or went looking.
    if (urlPath === '/endorse' || urlPath === '/queue' || urlPath === '/endorsements') {
      urlPath = '/endorse.html';
    }
    if (urlPath === '/foundations') urlPath = '/foundations.html';
    // The map (bc-34i0). Not a pill on the row — a page you read when you are new to the
    // system or arguing about it, not one you check. It draws the row anyway, with
    // nothing on it current, because it is one of the eight pages the deleted bottom bar
    // used to be the only way off (bc-khoe.1). `/map` as well as `/flow` because both
    // are what somebody types.
    if (urlPath === '/flow' || urlPath === '/map') urlPath = '/flow.html';
    // The ledger — every bead the selected space has ever had (bc-nib3.2), and the
    // first of the standing views to stop being a document at all. It is the shell's
    // History pane now (bc-khoe.30.5), so both of its addresses hop to `/#history`
    // rather than serving `history.html`: see `viewHop` above for why a rewrite cannot
    // do this and where the query string goes. `/history.html` is in the hop because
    // nothing else is left to want it — it was the service worker's own name for the
    // page, and the shell is what the service worker precaches now.
    //
    // public/history.js no longer has a document half at all (bc-khoe.30.15) — it only
    // ever draws the pane now — and public/history.html is gone from disk. `/history.html`
    // stays in this hop regardless: it is an address, not a file, and a bookmark or a
    // notification minted before this bead still has to land on `/#history`.
    if (urlPath === '/history' || urlPath === '/history.html') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('history', url));
    }
    // Where everything in flight is (bc-khoe.7) — the two queues as cards, and the deploy
    // strip that used to sit at the top of the PR board. `/deploys` as well as `/releases`
    // because the strip is what most people came here for and a deploy is the word they
    // will reach for; it is *not* what the page is called, because a branch waiting to
    // merge is on this page before any deploy exists. Both are the Releases pill's `paths`
    // in public/viewbar.js.
    //
    // A hop since bc-khoe.30.14 filled the Releases container. public/releases.js no
    // longer has a document half at all (bc-khoe.30.22) — it only ever draws the pane now
    // — and public/releases.html is gone from disk. `/releases.html` stays in this hop
    // regardless: it is an address, not a file, and a bookmark or a notification minted
    // before this bead still has to land on `/#releases`.
    if (urlPath === '/releases' || urlPath === '/deploys' || urlPath === '/releases.html') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('releases', url));
    }
    // The selected space's own settings (bc-khoe.10) — what it may interrupt you about,
    // what its agents may do unasked, and what each of its repos resolves to. Two paths:
    // `/config` is the word the chip it used to be was labelled with, and `/settings` is
    // what somebody types. Not `/space`, which reads as the picker rather than as the
    // thing it selects — and *not* the machine's settings, which are /admin.
    if (urlPath === '/config' || urlPath === '/settings') urlPath = '/config.html';
    // The requirement graph and its coverage (bc-fvmx.8). Two paths, because the page is
    // reached both by what it holds — requirements — and by what a reader actually goes
    // there to check, which is how much of the corpus is covered.
    if (urlPath === '/requirements' || urlPath === '/coverage') urlPath = '/requirements.html';
    // The skill library and whether anything uses it (bc-dgx7.5). Two paths, because the
    // page is reached both by what it holds — skills — and by the programme's own name for
    // the thing that fills it, which is the candidates waiting to become one. Not a pill,
    // for the reason /requirements is not: a page you read when you are arguing about the
    // system rather than one you check. It draws the row anyway, with nothing current.
    if (urlPath === '/skills' || urlPath === '/candidates') urlPath = '/skills.html';
    /**
     * `/closed` and `/done` — what got **finished**, as a place rather than a query
     * string somebody has to know how to type (bc-nib3.7).
     *
     * Every other surface in this app is about work that is not done: the inbox is what
     * needs answering, the console is what is running this minute, the board is what is
     * waiting to land. The one question none of them takes is *what shipped* — and since
     * the ledger's filters landed that has been one URL away, `/history?status=closed`,
     * which is a thing you can send somebody and not a thing you can reach for.
     *
     * **A redirect, and that is the whole reason it is not one more line in the run
     * above.** Those rewrite `urlPath` and leave the query string exactly as the browser
     * sent it, so `/closed` aliased to `/history.html` would arrive with no `status=` on
     * it and the page would have no way at all to tell it came in by that door. The
     * filter state lives in the URL and nowhere else — no localStorage half, no
     * server-side memory, see public/history.js — so the only thing that can narrow the
     * list is an address that says it is narrowed. Which is the second reason: after the
     * hop the address bar is honest about what is on screen, the chips are drawn from it
     * pressed, and clearing them is a tap rather than a mystery.
     *
     * Everything else on the way in is carried across, `?t=` included — a notification
     * or a shortcut can open `…/closed?t=<token>` and the pairing that rides on it has
     * to survive the hop, or the second navigation is a login screen. `status` is the
     * one parameter this door decides: `/closed?status=open` is a contradiction, and the
     * name of the door wins.
     *
     * Deliberately *not* in `SHELL` in public/sw.js, unlike every other path here — a
     * redirect is the one response the Cache API refuses to store, and the shell is
     * installed all-or-nothing. The comment beside `/history` there says so at length.
     * What that used to cost — `/closed` typed with no signal landing on the inbox — it
     * no longer does: the worker answers the hop itself now (`VIEW_HOPS`), because the
     * far end is a fragment of a document it already has rather than a page only the
     * daemon can name.
     *
     * The far end moved with the ledger (bc-khoe.30.7). It is `/#history?status=closed`
     * now rather than `/history?status=closed`, for the reason `viewHop` gives: the
     * ledger is a pane, its filters live in the hash, and a `status=` left in the search
     * string would be a filter for a view the next tap takes you off.
     */
    if (urlPath === '/closed' || urlPath === '/done') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('history', url, [['status', 'closed']]));
    }
    // The in-app terminal, with or without a terminal id in the query.
    if (urlPath === '/terminal') urlPath = '/term.html';
    // The advocate console — what bin/monitor.js showed in one line per repo, in
    // full, and the sessions view with it (see `/work` above). `/advocates` too,
    // because two people will guess two different names for it and the LaunchAgent
    // only ever opens one of them.
    // A hop rather than a rewrite since bc-khoe.4, with `/monitor.html` in the list for
    // the reason `/history.html` is in the ledger's: nothing is left to want it as a file.
    if (urlPath === '/monitor' || urlPath === '/advocates' || urlPath === '/monitor.html') {
      const signIn = hopGate(req, url);
      if (signIn) return redirect(res, signIn);
      return redirect(res, viewHop('advocates', url));
    }
    // The sign-in screen, and the one page that is never gated — see the gate below.
    // It is also where a browser is sent when it has no credential at all, so it has
    // to answer to the short path a person would type.
    if (urlPath === '/login') urlPath = '/login.html';
    // Pause all / resume all. Its own page rather than a block on the console: it is
    // the one control here that stops everything at once, and a screen you visit
    // constantly is the wrong place to keep a button like that.
    if (urlPath === '/admin') urlPath = '/admin.html';
    // The notification-sound audition. Its own screen because a channel's sound is
    // immutable once the channel exists, so the last moment three .wav files can be
    // argued with is before bc-ka5y.15.4 cuts the channels — and the only place the
    // argument is worth having is the phone. `/audition` too, because that is the word
    // the bead and the README both use for what happens here, and it is the one a
    // person would type.
    if (urlPath === '/sounds' || urlPath === '/audition') urlPath = '/sounds.html';
    /*
      A scoped address is the shell (bc-xnj67) — `/bdcoz/personal/deluvia`, the space and
      the workspace this page is looking at, with the view still in the hash.

      **A rewrite here, where `viewHop` needed a 302.** The two are not in tension: that
      one had to put a *fragment* on the address bar, and a fragment is the one thing a
      server cannot send. This puts nothing on the address bar. The address is already
      what it should be — the client reads `location.pathname` — so the honest answer is
      to serve the document at the address that was asked for and let the hash do what it
      has always done.

      Every `/bdcoz/**` is served rather than validated. An unknown space is a scope the
      client drops back to the stored filter, exactly as an unrecognised hash falls to
      Home: a typo should show the app, not a 404, and this file has no business being the
      place that knows which spaces exist.

      Before `rel`, so the sign-in gate below sees `index.html` and applies — and `next`
      is built from `url.pathname`, the address as it arrived, so signing in comes back to
      the scope you asked for rather than to `/`.
    */
    if (urlPath === `/${SCOPE_ROOT}` || urlPath.startsWith(`/${SCOPE_ROOT}/`)) urlPath = '/index.html';
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

    /**
     * With sign-in on, a browser asking for a *page* with no credential is sent to
     * the login screen instead of the page.
     *
     * Only pages. Every asset stays open — `/style.css`, `/app.js`, `/icon.svg`,
     * `/sw.js`, the vendor bundles — and that is not laziness: none of them contains
     * anything, the data all arrives later through `/api/*` behind the same gate as
     * before, and gating the service worker or the manifest breaks an installed PWA in
     * ways that look nothing like "please sign in". The document is the right place to
     * intercept, because the document is the only thing a person navigates to.
     *
     * `?t=<token>` still gets in, and this is the load-bearing half: an ntfy
     * notification opens `https://…/?t=<token>#<bead>`, and scripts/shot.mjs navigates
     * a headless Chrome the same way. Neither can sign into anything, and both must
     * keep working with sign-in on.
     *
     * A redirect rather than the login page served in place, so that public/sw.js
     * cannot end up with a login screen cached under `/` — it caches by request, and
     * network-first would happily store whatever came back.
     */
    let pairing = null;
    if (rel.endsWith('.html') && rel !== 'login.html' && (req.method === 'GET' || req.method === 'HEAD')) {
      const auth = authNow();
      if (auth) {
        sigKey = sigKey || sessionKey();
        // A `?t=` on a page request pairs the browser, so the *next* navigation works
        // too — a token lives in localStorage and rides on no navigation at all. See
        // PAIR_COOKIE in lib/auth.js for why that is not a second credential.
        if (hasToken(req, url)) pairing = pairCookie(auth, sigKey);
        else if (!sessionOf(req) && !paired(req, sigKey)) {
          const next = urlPath === '/' ? '/' : url.pathname + (url.search || '');
          return redirect(res, `/login?next=${encodeURIComponent(next)}`);
        }
      }
    }
    const full = path.resolve(PUBLIC_DIR, rel);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
      return json(res, 403, { error: 'forbidden' });
    }
    try {
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) throw new Error('dir');
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': stat.size,
        'cache-control': urlPath.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
        ...(pairing ? { 'set-cookie': pairing } : {}),
      });
      fs.createReadStream(full).pipe(res);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    /**
     * Time this request, and put it in scope for every `bd`, `gh` and `git` it spawns.
     *
     * One line, and it has to be the *first* line: everything below it — the static
     * fallthrough, the auth family, the 401, the streamed file that never returns
     * through here at all — is a request somebody waited for, and a page load is the
     * sum of a dozen of them rather than one `/api/` call. The key is method and path
     * with the query dropped, so `?refresh=1` and a plain fetch of the same route
     * aggregate together; see lib/timing.js for why warm and cold are then counted
     * apart, and for why `/api/poll` is not allowed to pollute either.
     *
     * Deliberately not a wrapper around `handler`: `routeTable` derives the route table
     * from this function's own *source*, so a wrapper would hand it a body with no
     * routes in it and turn `assertRoutes` — and the suite that checks the two agree —
     * into a silent no-op.
     */
    timing.instrument(req, res, `${req.method} ${p}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-headers': 'content-type,x-beadcause-token' });
      return res.end();
    }

    // How you get a credential, so it cannot be behind one. See serveAuth.
    if (p === '/auth' || p.startsWith('/auth/')) {
      try {
        return await serveAuth(req, res, url);
      } catch (err) {
        console.error('[auth] route failed:', err.message);
        return redirect(res, '/login?error=failed');
      }
    }

    if (!p.startsWith('/api/')) return serveStatic(req, res, url, p);

    if (p === '/api/health') return json(res, 200, { ok: true, workspaces: [...workspaces.keys()] });

    /**
     * Two credentials, and the token is asked first — every time, for every caller.
     *
     * The order is the compatibility guarantee. Nothing about a token-authenticated
     * request reaches the sign-in code at all: an ntfy action button, lib/notify.js
     * calling back, the Android app, scripts/shot.mjs, `curl` and the router's proxy
     * hop all take the same branch they always did, whether sign-in is configured or
     * not. The session is only consulted for a request that had no token — which is
     * to say, only for a browser.
     */
    if (!hasToken(req, url) && !sessionOf(req)) {
      return json(res, 401, { error: 'bad or missing token' });
    }

    try {
      /**
       * `/api/views` — every view the configured repos declare about themselves.
       *
       * The shell asks once at boot and builds a pill, a pane and an address for each
       * answer (public/viewhost.js). It is deliberately cheap: reading a JSON file per
       * workspace and stat-ing the scripts it names, and *not* running any generator —
       * a page that had to wait for `scripts/studio_board.py` before it could draw its
       * pill row would be a page that lost the whole point of the shell.
       *
       * Scoped to the active account like every other payload that names workspaces, so
       * switching account changes which repos' views are on the row. `problems` is a flat
       * list of sentences rather than an error: a manifest with one bad entry still hands
       * over its good ones, and the bad one is a line on the Config screen instead of a
       * view that silently is not there.
       */
      if (p === '/api/views' && req.method === 'GET') {
        const { views, problems } = repoviews.allViews(cfg, scopedWorkspaces());
        return json(res, 200, {
          // `run` is dropped on the way out. It is an argv this daemon spawns and the
          // browser has no use for it — the page fetches `dataUrl` and never knows what
          // produced it, which is what lets a repo change its generator without the
          // shell finding out.
          views: views.map(({ run, ...v }) => ({ ...v, generated: Boolean(run?.length) })),
          problems,
          held: repoviews.heldAges(),
        });
      }

      /**
       * `/api/views/<workspace>/<id>/data` — one view's payload, from its own generator.
       *
       * Held for the manifest's `ttl` and shared between concurrent callers; `?refresh=1`
       * spends a real run, which is what the ⟳ in the mark's menu sends. A generator that
       * fails does not evict what is held: the answer carries the last good payload,
       * `stale: true` and the reason, and the pane draws the board with a line above it
       * rather than going blank. See `payloadFor` in lib/repoviews.js.
       *
       * A 502 is the right status for the case where there is nothing held to fall back
       * on — the failure is in something this server called, not in what was asked of it.
       */
      if (p.startsWith('/api/views/') && p.endsWith('/data') && req.method === 'GET') {
        const parts = p.slice('/api/views/'.length, -'/data'.length).split('/');
        if (parts.length !== 2) return json(res, 404, { error: 'no such view' });
        const full = repoviews.viewId(decodeURIComponent(parts[0]), decodeURIComponent(parts[1]));
        const view = repoviews.findView(cfg, scopedWorkspaces(), full);
        if (!view) return json(res, 404, { error: 'no such view' });
        const out = await repoviews.payloadFor(cfg, view, {
          refresh: url.searchParams.get('refresh') === '1',
        });
        if (out.problem && out.data === undefined) {
          // Marked as not-the-daemon-failing, exactly the way bin/router.js marks the 503
          // it answers for a request lost to a swap. The status stays 502 — something this
          // server called did fail — but public/report.js files a sev2 P0 for every
          // unmarked 5xx, and a foreign repo's generator that timed out is not the daemon
          // having stopped working. The pane has already drawn the reason where the board
          // would be (`pull` in public/viewhost.js), which is the whole of what the reader
          // needs. bc-3wf1r, filed when deluvia's `studio` generator ran past its 30s on a
          // loaded machine; bc-xl7n.134 is the precedent this copies.
          return json(
            res,
            502,
            { error: out.problem, view: full, code: repoviews.GENERATOR_CODE },
            { [repoviews.GENERATOR_HEADER]: '1' }
          );
        }
        return json(res, 200, { view: full, ...out });
      }

      if (p === '/api/questions' && req.method === 'GET') {
        // Unrecognised (or absent) falls back to `human`, so an old client — the
        // Android app, a cached service worker — keeps getting exactly what it
        // always got rather than an error.
        const asked = url.searchParams.get('scope');
        const scope = SCOPES.has(asked) ? asked : 'human';
        // Fetched together: `both` is two independent sweeps of the same seven
        // workspaces, and serialising them would double the wait on the phone.
        //
        // The third is the foundation channel, and it is fetched separately *only*
        // in the one scope that has no `human` sweep to split it out of. In the other
        // two it is free — see `splitChannels`.
        const [human, agents, agentScopeRequests] = await Promise.all([
          scope === 'agent' ? [] : allQuestions(),
          scope === 'human' ? [] : agentBeads(),
          scope === 'agent' ? foundationRequests() : [],
        ]);
        const { questions, requests } = splitChannels(human);
        // Questions first regardless of how they sort among themselves: something
        // is waiting on you, and it must not end up below sixty beads of backlog.
        const rows = [...questions, ...agents];
        return json(res, 200, {
          // `questions`, `requests`, `workspaces`, `spaces`, `consoles`, `filter`
          // and `summary`, all of them built by `inboxPayload` above —
          // which is also what `/api/poll` answers with, so a client can refresh
          // itself from either and get the same screen. Its own field, never folded
          // into `questions`: a client that does not know about the foundation
          // channel shows the inbox exactly as it did before and simply does not
          // draw the requests, which is the right failure.
          // Which sweeps this scope actually ran, so the trouble reported is trouble
          // about the list underneath it — see `sweepTrouble`. `human` splits its
          // foundation requests out of the questions it already has, so it runs one.
          ...(await inboxPayload(
            rows,
            scope === 'agent' ? agentScopeRequests : requests,
            scope === 'agent' ? ['beads', 'foundation'] : scope === 'both' ? ['questions', 'beads'] : ['questions']
          )),
          scope,
          // Where in the event log this list was true. It is what lets the page stop
          // asking for the whole list on a timer: park on `/api/poll?since=<seq>` and
          // the daemon answers when something actually moves — with this same payload
          // — rather than sweeping `bd` across seven workspaces every 25 seconds to
          // be told nothing has. Additive: a client that ignores it polls exactly as
          // it always did.
          seq: bus.seq,
        });
      }

      /**
       * The foundation channel, and nothing else.
       *
       * The distinct route the separation is built on. Everything it returns is also
       * in `/api/questions` and `/api/poll` for the scopes that sweep the inbox — this
       * is for the caller that wants the channel without the inbox: the agent scope,
       * a badge, a watch face, or `curl` when you want to know whether anything is
       * asking to be different without reading seven workspaces of backlog.
       *
       * The bare path is this, and only this. One agent's foundation is
       * `/api/foundation/agent` — it used to be here too, on the same method and path,
       * where it was unreachable; see the note there.
       */
      if (p === '/api/foundation' && req.method === 'GET') {
        const requests = await foundationRequests();
        return json(res, 200, { requests, workspaces: scopedWorkspaceNames() });
      }

      if (p === '/api/question' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = url.searchParams.get('id');
        // One spawn for the pair, the same as `/api/bead` — bc-kki5, and the note on
        // `Bd.showWithComments` is the argument. This route is the *other* detail sheet
        // and it had the identical shape: `show`, then `comments`, and the card waiting
        // on the sum. It was the sixth-worst route on this daemon at a p50 of 5.9s.
        const issue = await bd.showWithComments(ws, id);
        if (!issue) return json(res, 404, { error: 'not found' });
        const q = toQuestion(ws.name, issue);
        q.comments = issue.comments;
        // Same two fields /api/questions adds. Without them the detail fetch that
        // runs right after you comment would return a question with no activity,
        // and the "an agent is working" indicator wouldn't appear until the next
        // 25s list poll — precisely when you're staring at the thread waiting.
        q.activity = activityFor(q.key, issue.labels, readActivity());
        q.awaitingAgent = (issue.labels || []).includes(REPLIED_LABEL);
        // Which channel it came from, so an open card keeps its own frame when the
        // detail fetch merges over the list row that was drawn from.
        q.foundation = (issue.labels || []).includes(AMENDMENT_LABEL);
        // And the same field the list carries, so the open card does not lose the "you
        // answered this already" banner the moment the detail fetch merges over the row
        // it was drawn from.
        q.answeredBefore = answeredBefore(loadState().answered, q.key);
        // And the same again for how this card arrived, so opening it does not drop the
        // "arrived quietly" line the list row was drawn with.
        q.arrivedQuiet = arrivedQuiet(loadState().quiet, q.key);
        // Would bd refuse to close this bead — asked when the card opens rather than
        // when you press. `/api/respond` asks the same question at write time and
        // answers a refusal with a 409, which is correct and is also too late to be
        // kind: an epic with thirty open children took a typed answer and a press to
        // tell you the button was never going to work. Known here, the card does not
        // draw the button at all (see freeformHtml).
        //
        // Free for anything that is not an epic — the blockers are already on the
        // `show` above — and one `bd list --parent` for one that is. Deliberately not
        // added to `/api/questions`: there it would be a child list per epic row on
        // every 25-second poll, for cards nobody has opened.
        q.gate = await bd.gateFor(ws, issue);
        return json(res, 200, q);
      }

      /**
       * The live state of one delivery's pull request.
       *
       * Deliberately its own route rather than a field on `/api/questions`. The
       * numbers that matter here — diffstat, check rollup, whether GitHub will
       * actually take it — come from the network, and folding them into the list
       * would mean a `gh` call per delivery on every 25-second poll, for cards
       * nobody is looking at. So the card draws from the block immediately and
       * fills in the live half when you open it.
       *
       * Every failure is an answer here, never a 500: `gh` missing, the PR deleted,
       * GitHub unreachable. A card that cannot reach GitHub should say so and still
       * offer the link, because the link is what you wanted anyway.
       */
      if (p === '/api/pr' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = url.searchParams.get('id');
        const issue = await bd.show(ws, id);
        if (!issue) return json(res, 404, { error: 'not found' });
        const d = parseDelivery([issue.description, issue.design, issue.notes].filter(Boolean).join('\n\n'));
        if (!d || d.error) return json(res, 404, { error: d?.error || 'no beadpr block on this question' });

        const gh = await pr.available();
        if (!gh.ok) return json(res, 200, { delivery: d, pr: null, unavailable: gh.reason });
        try {
          // The card's own repo, not the workspace's — `unitForDelivery`. A read rather than
          // an act, so getting it wrong here draws somebody else's #123 on the card instead of
          // merging it, which is the same mistake one screen earlier.
          const { dir } = await unitForDelivery(ws, d);
          return json(res, 200, { delivery: d, pr: await pr.view(dir, d.number), unavailable: null });
        } catch (err) {
          return json(res, 200, { delivery: d, pr: null, unavailable: err.message });
        }
      }

      /**
       * One pull request, everything a decision about it needs — the full view's fetch.
       *
       * `/api/pr` above is keyed on a *bead*: it reads a `beadpr` block and answers "what
       * is the state of the pull request behind this card". This is keyed on the pull
       * request itself, which is what the board's rows and the inbox's PR cards are, and
       * it is what the full-screen view opens with (bc-l8jp.7).
       *
       * Three sources, and each is the only one that knows its half:
       *
       * - **the board row** — the stage, the four lamps, the beads. All of it is git and
       *   `bd` work that only lib/prboard.js does, and it is deliberately taken from the
       *   25-second sweep rather than recomputed: a view whose lamps disagreed with the
       *   list it was opened from would be one screen contradicting another about the one
       *   subject where that is the whole failure.
       * - **`gh`, now** — the description, the datetimes, and the mergeability the buttons
       *   are drawn from. Fresh on purpose, and the reason this endpoint exists at all:
       *   the number that must be right is the one you are looking at when you press
       *   merge, and the board strips the description from every row (`body: undefined`)
       *   because it is the whole payload.
       * - **the session archive** — which agent wrote it. See lib/prauthor.js for why that
       *   is a real lookup rather than the author login GitHub reports.
       *
       * Every failure is an answer here and never a 500, exactly as `/api/pr` has it: a
       * view that cannot reach GitHub should say so and still draw the row, the beads and
       * the link, because the link is what you wanted anyway.
       */
      if (p === '/api/pr/detail' && req.method === 'GET') {
        const { ws, unit } = requireUnit({ key: url.searchParams.get('key'), workspace: url.searchParams.get('workspace') });
        const row = await prBoardRow(unit, Number(url.searchParams.get('number')), {
          force: url.searchParams.get('refresh') === '1',
        });
        let dir = null;
        try {
          dir = checkoutOf(unit);
        } catch (err) {
          return json(res, 200, { row, pr: null, agent: null, unavailable: err.message });
        }
        let live = null;
        let unavailable = null;
        try {
          live = await pr.viewDetail(dir, row.number);
        } catch (err) {
          unavailable = err.message;
        }
        // Local git against the repo's own refs, so it costs nothing worth caching — and
        // it never takes the response down with it: an unattributable pull request is an
        // ordinary one, not an error.
        const agent = await authorOf(dir, row).catch((err) => {
          console.error(`[pr] ${ws.name}: could not attribute #${row.number} — ${err.message.split('\n')[0]}`);
          return null;
        });
        return json(res, 200, { row, pr: live, agent, unavailable });
      }

      /**
       * Close it without merging — and touch nothing else, deliberately.
       *
       * The third thing the full view can do (bc-l8jp.7), and the one where what it
       * *doesn't* do is the design. `gh pr close`, with the reason box's words as a
       * comment on the pull request so the closed tab is not a mystery six weeks later.
       * Then it stops.
       *
       * ## Why no bead moves here
       *
       * Because the act that moves beads already exists and is better at it. **Decline**
       * on a delivery card closes the PR *and* reopens the work bead unclaimed with the
       * direction to take instead (see `resolveDeliveryFor`) — and it can, because the
       * bead it acts on is named by the `beadpr` block the worker wrote. What this
       * endpoint has is `row.beads`, which lib/beadref.js *matched* — from the branch
       * name, the title, or a claim in the body. Those tiers are right for drawing a link
       * on a row and much too weak to reopen a bead on, because reopening one is what
       * puts an advocate's unattended session on it: a pull request whose body said
       * "fixes bc-x" would start a session in another repo at three in the morning.
       *
       * So the two paths stay distinct and the response says so, rather than this one
       * quietly becoming a worse decline. A delivery card about this pull request is still
       * in the inbox afterwards, still the place the bead goes back in the queue — and it
       * draws itself correctly over a closed PR already: `mergeLabel` says "#N is closed"
       * and the merge button disables itself.
       *
       * Refused on a merged pull request rather than passed to `gh`, which would close the
       * *branch's* tab and say nothing about the merge: closing something already merged
       * cannot un-merge it, and a button that appeared to would be the worst kind of lie
       * on this screen.
       */
      if (p === '/api/pr/close' && req.method === 'POST') {
        const body = await readBody(req);
        const { ws, unit } = requireUnit(body);
        // Forced, like every acting call: what is closed must be what is true now, not
        // what a phone left open overnight was drawn with.
        const row = await prBoardRow(unit, Number(body.number), { force: true });
        if (row.merged) {
          return json(res, 409, { error: `#${row.number} is already merged — closing it now would not un-merge it` });
        }
        if (row.state === 'CLOSED') {
          return json(res, 409, { error: `#${row.number} is already closed` });
        }
        const why = String(body.reason || '').trim();
        const dir = checkoutOf(unit);
        // Verbatim under a heading that says where it came from. The heading is ours; the
        // sentence is whatever was typed, because it is the only thing on the closed pull
        // request that will explain it to whoever opens it next.
        const closed = await pr.close(dir, row.number, {
          comment: why
            ? `**Closed from beadcause** — ${why}`
            : 'Closed from beadcause without merging. No reason was given.',
          // The branch stays. It is the only copy of the work outside a worktree that may
          // already have been retired, and deleting it from a phone over a decision that
          // carried no direction is not recoverable.
          deleteBranch: false,
        });
        forgetBoard(dir);
        console.log(`[pr] ${ws.name}: closed #${row.number} without merging${why ? ' with a reason' : ' with no reason given'}`);
        return json(res, 200, {
          ok: true,
          pr: closed,
          number: row.number,
          reason: why,
          // Named rather than left to be inferred from the absence of anything about beads:
          // the phone says this sentence out loud, because "the PR is closed and the work
          // is still claimed by a session that has exited" is exactly the state someone
          // would otherwise discover next week.
          beads: (row.beads || []).map((b) => b.id),
        });
      }

      /**
       * A conflict is work, so: a session on the branch.
       *
       * The fourth thing the full view can do, and the one the board never could. GitHub
       * refusing a merge for a conflict is the one refusal that is not a decision — nobody
       * has to choose anything, somebody has to merge `${base}` into the branch and re-run
       * the tests — and until this existed the phone's answer was lib/pr.js's sentence
       * ("the branch needs a rebase before it can merge") and no way to act on it.
       *
       * Deliberately the same act as **Request changes** on a delivery card: a note back to
       * a session on the same branch. See `conflictPromptFor` in lib/session.js for what it
       * is asked to do, and for the two things it is told not to — merge into the base, or
       * merge its own result.
       *
       * Refused unless GitHub says it is conflicting *now*, asked again here rather than
       * trusted from the row: a session opened for a conflict that has already been
       * resolved is a window someone has to go and close, and the whole point of the
       * refusals on this screen is that a pointless window is worse than a sentence.
       */
      if (p === '/api/pr/conflicts' && req.method === 'POST') {
        // Same refusal as `/api/pr/ship` and `/api/session`, for the same reason: an
        // observer on a spare port shares these checkouts, and opening an unattended
        // session in a repo it is only visiting is not a thing it should be able to do.
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const { ws, unit } = requireUnit(body);
        const row = await prBoardRow(unit, Number(body.number), { force: true });
        if (row.state !== 'OPEN') {
          return json(res, 409, {
            error: `#${row.number} is ${row.merged ? 'merged' : 'closed'} — there is no conflict left to resolve`,
          });
        }
        if (row.mergeable !== 'CONFLICTING') {
          return json(res, 409, {
            error: `GitHub does not report #${row.number} as conflicting${
              row.mergeable === 'UNKNOWN' ? ' yet — it is still working the merge base out' : ' — nothing needs rebasing'
            }`,
          });
        }
        // Last, deliberately, and after the two refusals above: "openSessions is disabled"
        // over a pull request that has no conflict is a true sentence answering a question
        // nobody asked, and the reason someone pressed this is the conflict rather than the
        // window. Same order `/api/pr/ship` keeps it in, where the check sits on the one
        // branch that actually opens something.
        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });

        /**
         * And the last refusal, which is about *this Mac* rather than about the pull
         * request or about who is asking: one press of this button once produced two
         * sessions, in one worktree, merging the same base at the same time — bc-utyr,
         * and the commit it put conflict markers into is named in lib/resolvers.js.
         *
         * After `openSessions` deliberately, and it costs nothing to be there: a daemon
         * with windows switched off has never opened a resolver, so there is nothing for
         * this to find. It wraps the launch rather than preceding it because the decision
         * and the act have to be one critical section — the two requests that caused the
         * incident arrived a moment apart, and a check with an `await` between it and the
         * launch is a check both of them pass.
         */
        // Keyed per repo, like the resolver's own lock: two Climative services each have a
        // #1, and a lock keyed by workspace would refuse the second one as a duplicate of a
        // session opened in a different checkout entirely.
        const outcome = await resolveFor(unit.key, row.number, () => openConflictSession(cfg, ws, row, { dir: checkoutOf(unit) }), {
          branch: row.branch,
          owner: ownerName(cfg),
          /**
           * And what to ask if this one has to wait for a window — the two refusals
           * above, asked again at the moment the window would actually open.
           *
           * The press was refused unless GitHub reported the conflict *right now*, for
           * the reason that a session opened for a conflict somebody has already
           * resolved is a window you have to go and close. A queued press has the same
           * problem twice over: the wait can be an hour, and everything that could clear
           * the conflict — another resolver pushing, a merge from the phone — is more
           * likely to have happened during it than before it.
           */
          recheck: async () => {
            const latest = await prBoardRow(unit, row.number, { force: true });
            if (latest.state !== 'OPEN') {
              return `#${row.number} was ${latest.merged ? 'merged' : 'closed'} while it waited for a window — no conflict left to resolve`;
            }
            if (latest.mergeable !== 'CONFLICTING') {
              return `#${row.number} stopped conflicting while it waited for a window — nothing needs rebasing`;
            }
            return true;
          },
        });
        if (outcome.error) {
          console.log(`[pr] ${ws.name}: no second session for #${row.number} — ${outcome.error}`);
          return json(res, outcome.status || 409, { error: outcome.error });
        }
        if (outcome.reused) {
          console.log(`[pr] ${ws.name}: #${row.number} already has a session on ${row.branch} — told it rather than opening another`);
          return json(res, 200, { ok: true, reused: true, note: outcome.note, number: row.number, branch: row.branch });
        }
        // A full Mac, which is a 200 and not a refusal: the work is still going to
        // happen. `MAX_LIVE` resolvers each run the repo's own gate, and a sweep can
        // hand over five at once — see the cap in lib/resolvers.js. The window opens
        // when one of the running ones closes, and GitHub is asked again first.
        if (outcome.queued) {
          console.log(`[pr] ${ws.name}: ${outcome.note}`);
          return json(res, 200, {
            ok: true,
            queued: true,
            place: outcome.queued.place,
            note: outcome.note,
            number: row.number,
            branch: row.branch,
          });
        }
        const opened = outcome.opened;
        console.log(`[pr] ${ws.name}: conflict session for #${row.number} on ${row.branch} in ${opened.dir} (${opened.mode})`);
        return json(res, 200, { ok: true, ...opened, number: row.number, branch: row.branch });
      }

      /**
       * The PR board — every repo's pull requests and how far each one got.
       *
       * `/api/pr` above answers "what is the state of the one PR behind this card".
       * This answers the question that outlives the card: what is open, what merged,
       * what reached origin, and what is actually running. See lib/prboard.js.
       *
       * `?refresh=1` is the ⟳ on the page. Without it the sweep is served from a
       * 25-second cache, because the page polls and two phones looking at the same
       * board must not be twice the `gh` traffic of one — and since bc-1kwl.3 that
       * cache is lib/cache.js, so past 25 seconds the kept board comes back now and
       * the sweep runs behind the response. It is the route that needed that most:
       * 74 seconds measured under bc-1kwl.1, three times its own window.
       */
      if (p === '/api/prs' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        // `kept` off the sweep before anything narrows it: how old the answer is goes on
        // a header and never into the body — the convention /api/history set for the
        // routes converting after it (see `KEPT_HEADER`) — and it is a fact about the
        // sweep, so narrowing cannot change it.
        //
        // `waitMs: CACHE_WAIT_MS` — bc-19vt.1. This is the phone's own request, not an
        // acting call, and it gains nothing from inheriting the sweep's whole 150-second
        // slot ceiling: `collectBoard` already answers `unavailable` for that, and the
        // sweep it started keeps running toward the real ceiling either way. Applies to
        // `force` (the ⟳) too — every tap is a cold read, and a busy Mac exposes it to
        // the full wait exactly as a plain poll would.
        const { kept, ...swept } = await collectBoard(bd, cfg, { force, waitMs: CACHE_WAIT_MS });
        if (kept) res.setHeader(KEPT_HEADER, describeKept(kept));
        // Swept for the whole Mac and narrowed on the way out — `narrowBoard` says why
        // that is the right way round, and it is the one place the second grain of an
        // account is actually load-bearing: a card here *is* a repo, so a Climative
        // account that names three of forty checkouts draws three cards. It is also what
        // keeps `board:` a single cache key while the account chip moves.
        const board = narrowBoard(swept, (card) =>
          repoInAccount(activeAccount(cfg, loadState()), card.workspace, splitRepoKey(card.key).wanted)
        );
        // Which daemon you are looking at. It matters more here than on most screens:
        // an observer can merge, because merging happens at GitHub — but "deployed"
        // then means *this* instance's build, and Ship is refused outright.
        //
        // The release queue rides on top of the sweep rather than inside it: it is a
        // read of the deploy journal, which changes every few seconds while something
        // is shipping, and the board underneath it is cached for 25. Folding the two
        // together would make the number on the Ship button as stale as the `gh` call.
        return json(res, 200, { ...decorateBoard(board, loadLedger() || {}, listDeploys({ limit: 200 })), observing: OBSERVING });
      }

      /**
       * The two queues, keyed by repo — where every bead in flight actually is.
       *
       * The merge queue and the release queue are different queues, entered by different
       * events and drained by different agents, and until this route there was nowhere
       * that said so: `lib/mergequeue.js` wrote its stages into a bead's notes,
       * `lib/deploy.js` wrote its own into a journal, and `lib/release.js` batched merges
       * behind a settle window. Three files, three clocks, no answer. lib/queues.js is
       * the composition and this is the door onto it.
       *
       * **Nothing here is swept for.** The board is `collectBoard`'s, cached 25 seconds
       * and shared with `/api/prs`; the journal is a directory read; the merge-beads are
       * `gatherMerges`, which asks the cheap `bd.graph()` question before spending a
       * subprocess and keeps its answer for twenty seconds. So a phone polling this and
       * the board together pays for one sweep, not two — which is the same argument
       * `decorateBoard` makes about riding on top of the board rather than inside it.
       *
       * Narrowed to the account exactly as `/api/prs` is, and for its reason: a card here
       * is a repo, so a Climative account naming three of forty draws three. `errors[]`
       * carries the workspaces whose tracker would not answer, because a merge queue that
       * came back empty because Dolt was mid-write must not read as a queue with nothing
       * in it.
       */
      if (p === '/api/queues' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        // `waitMs: CACHE_WAIT_MS` on both reads — bc-19vt.1, and this route is the one
        // that named the bug: a phone arriving on a cold `board:` or `queues:merges` key
        // used to inherit the full 150-second slot ceiling for no reason of its own.
        // Both `collectBoard` and `gatherMerges` already have somewhere honest to land a
        // "not yet" (`unavailable`, `errors[]`), so a short wait costs nothing here that
        // the abandoned sweep does not make good on the next poll.
        const { kept: boardKept, ...swept } = await collectBoard(bd, cfg, { force, waitMs: CACHE_WAIT_MS });
        const board = narrowBoard(swept, (card) =>
          repoInAccount(activeAccount(cfg, loadState()), card.workspace, splitRepoKey(card.key).wanted)
        );
        const { merges, errors, kept: mergeKept } = await gatherMerges(bd, cfg, { refresh: force, waitMs: CACHE_WAIT_MS });
        // How old the *oldest* half of the answer is — one header for a payload built from
        // two kept reads, because a client that trusted the fresher of the two would think
        // it had a merge queue as new as the board it arrived beside.
        const kept = combineKept([boardKept, mergeKept]);
        if (kept) res.setHeader(KEPT_HEADER, describeKept(kept));
        return json(res, 200, {
          ...queues(board, {
            merges,
            deploys: listDeploys({ limit: 200 }),
            ledger: loadLedger() || {},
            // The router's handover trail (bc-khoe.8) — one small file read, and the only
            // thing on this Mac that can say when a release reached green, passed its
            // health check and took over. Read here rather than inside `queues()` for the
            // reason nothing else in that file reads either: the composition stays pure.
            handovers: listHandovers(),
          }),
          unavailable: board.unavailable || null,
          errors,
          observing: OBSERVING,
        });
      }

      /**
       * Ship everything that has merged and is not running — one deploy, the lot.
       *
       * The row Ship next to it deploys too, and deliberately says the same word for
       * the same act: a deploy makes *every* merge on `origin/main` live, so pressing
       * it on one pull request has always shipped the four sitting behind it as well.
       * What it could not say was how many, which is the whole of bc-5r0v — six
       * sessions a day merge here and the number is the only thing that says whether
       * pressing this is routine or is the day's work going out at once.
       *
       * So this is not a second kind of deploy. It is the same `startDeploy`, with the
       * queue named in its `reason` so the record afterwards says what it carried, and
       * with the refusals that matter checked against the queue rather than a row:
       *
       * - **An empty queue is a 409, not a no-op deploy.** Nothing merged is waiting,
       *   and a restart of the daemon you are holding is not a thing to do by accident.
       *   Shipping something already live is still available on its own row ("Ship
       *   again"), where you have said which one and why.
       * - **A repo with no declaration cannot batch.** The single-row fallback opens a
       *   window on the Mac for one pull request; there is no window that means "and
       *   the other three", so this refuses and points at the row.
       *
       * The ship beads are not touched here. `sweepReleases` closes them when the merge
       * is actually live, which for this repo is after the restart that this call is
       * about to cause — a handler that closed them now would be closing them on the
       * strength of having started something.
       */
      if (p === '/api/release/ship' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const { unit } = requireUnit(body);
        const where = whereLanded(unit.workspace, unit.repo);
        // Forced, like every acting call: the queue this ships must be the one that is
        // true now, not the one a phone left open overnight was drawn with.
        const board = await collectBoard(bd, cfg, { force: true });
        if (board.unavailable) throw Object.assign(new Error(board.unavailable), { status: 409 });
        const card = pickCard(board, { key: unit.key });
        if (!card) throw Object.assign(new Error(`no ${where} on the board`), { status: 404 });
        if (card.error) throw Object.assign(new Error(card.error), { status: 409 });

        const queue = releaseFor(card, listDeploys({ limit: 200 }).filter((d) => keyOf(d) === unit.key), loadLedger() || {});
        if (!queue.count) {
          return json(res, 409, { error: `nothing is waiting to ship in ${where} — everything merged is already live` });
        }

        let plan;
        try {
          plan = deployFor(cfg, unit.key);
        } catch (err) {
          throw Object.assign(new Error(`${where} declares a deploy this cannot read — ${err.message}`), { status: 409 });
        }
        if (!plan) {
          return json(res, 409, {
            error: `${where} declares no deploy beadcause can run, so its queue cannot be shipped in one press — open a pull request's own Ship instead`,
          });
        }
        const already = runningFor(unit.key);
        if (already) return json(res, 409, { error: `a deploy of ${where} is already running`, deploy: already });

        const rec = beginDeploy(bus, cfg, unit.key, {
          // The oldest merge in the queue: the bead on the record is what a phone links
          // to afterwards, and the one that has been waiting longest is the one whose
          // thread most wants the news.
          bead: queue.prs[queue.prs.length - 1]?.bead || null,
          reason: shipReason(queue),
        });
        console.log(
          `[release] ${where}: shipping ${queue.count} merged pull request${queue.count === 1 ? '' : 's'} — ${rec.id} (pid ${rec.pid})`
        );
        return json(res, 200, { ok: true, deploy: rec, hint: deployHint(plan), release: queue });
      }

      /**
       * Merge it, and bring this Mac's `main` up with it.
       *
       * The merge is `gh pr merge` — lib/pr.js's, preflight and all — which lands the
       * commit on `origin/main` itself. So "and push" is not a push: by the time this
       * returns, the work is already off the laptop, and what is left is the local
       * `main` that is now a commit behind. `landLocally` does that half, and refuses
       * to touch a checkout with edited work in it — untracked residue it steps past
       * and says so (bc-45g8), because that is nobody's unsaved file and the checkout
       * this button moves is shared with every session on the Mac.
       *
       * The two halves are reported separately on purpose. A merge that lands and a
       * fast-forward that is refused because Adam has files open is a *good* outcome,
       * and one flat "failed" over both would send someone to GitHub to find out
       * which of them happened.
       *
       * There is a third half now, and it is the one this endpoint used to be missing:
       * a pull request delivered by a worker that could not merge it has a "Merge #N?"
       * card in the inbox, and merging *here* answered that question without saying so.
       * `retireDeliveryCards` closes it. See it for why the board is allowed to write.
       */
      if (p === '/api/pr/merge' && req.method === 'POST') {
        const body = await readBody(req);
        const { ws, unit } = requireUnit(body);
        const row = await prBoardRow(unit, Number(body.number), { force: true });
        const dir = checkoutOf(unit);
        const merged = await pr.merge(dir, row.number, { method: body.method || cfg.pr?.mergeMethod || 'merge' });
        const land = await landLocally(dir, row.base || configuredBase(cfg, ws.name));
        // The sweep this came from is now wrong about the one row anyone is looking at, and
        // so is `gh`'s own answer about this checkout — which is why the directory is named.
        forgetBoard(dir);
        const base = row.base || configuredBase(cfg, ws.name);
        // And the other rows are now wrong in a way no refresh fixes: a merge conflicts
        // the branches behind it. The fourth door into `main` and the same call as the
        // other three — lib/mergesweep.js, drained by the poll cycle.
        requestSweep({ workspace: ws.name, key: unit.key, number: row.number, base, why: `the PR board in ${ws.name}` });
        const retired = await retireDeliveryCards(ws, {
          number: row.number,
          repo: row.repo || '',
          base,
          sha: merged.mergeCommit || '',
          actor: actorFor(req),
        }).catch((err) => {
          // Belt and braces over a function that already catches everything: the merge
          // has landed, and a card left open is worth a log line and never a 500 over
          // work that is already in `main`.
          console.error(`[pr] ${ws.name}: could not retire the cards for #${row.number} — ${err.message.split('\n')[0]}`);
          return { cards: [], why: err.message.split('\n')[0] };
        });
        console.log(
          `[beadcause] merged ${ws.name} #${row.number}${merged.alreadyMerged ? ' (already merged)' : ''} — ${land.note}`
        );
        /*
         * One event, and only when something actually moved in the tracker.
         *
         * The emit that used to be here unconditionally was `pr-merged`, and nothing
         * ever read it: no page, no script, and not the Android watch service, which is
         * the one client that parks on `/api/poll` across a merge. What it *did* do was
         * cost something. `changed` in the poll handler is `events.some((e) => e.type
         * !== 'presence')`, so any event but presence makes the daemon sweep `bd` across
         * every workspace and hand the result to every parked client — and a merge that
         * changed no bead here made that sweep come back with the list it already had.
         * One full multi-workspace sweep, per merge, to tell everyone nothing.
         *
         * A retired card is the opposite case and the reason that comment ended by
         * saying the real event was still to come: a card has just left the inbox, every
         * parked phone is still drawing it, and the sweep those clients get back is a
         * genuinely different list. So the event fires per card retired and not at all
         * when none was — the cost is paid exactly when there is news to pay it for.
         */
        for (const card of retired.cards) {
          if (!card.closed) continue;
          bus.emit({
            type: 'merged',
            key: `${ws.name}/${card.id}`,
            workspace: ws.name,
            id: card.id,
            bead: card.bead,
            number: row.number,
          });
        }
        return json(res, 200, {
          ok: true,
          pr: merged,
          alreadyMerged: Boolean(merged.alreadyMerged),
          land,
          // What the phone says it did beyond merging. Named rather than inferred from
          // the absence of an error: "and closed bc-x" is the half a person on /prs
          // would otherwise have to go to the inbox to discover.
          cards: retired.cards,
          cardsWhy: retired.why,
        });
      }

      /**
       * Ship it — the declared deploy where there is one, a window on the Mac where
       * there is not.
       *
       * This button used to be *only* the window, because until a deploy could be
       * declared (lib/deploy.js) there was nothing here to run: what a deploy *is*
       * lives in each repo's CLAUDE.md, and beadcause could neither read that nor
       * guess it. A repo that has since written the thing down is a different case,
       * and the two are not interchangeable in either direction:
       *
       * - **Declared → run it.** `deploys.<workspace>` is argv this Mac has been told
       *   to run for exactly this, it pulls the checkout and refuses over uncommitted
       *   work, it rebuilds what the merge moved, and every step of it is journalled
       *   and pushed to the phone. That is the whole of what the session brief asks an
       *   agent to do by hand — and it is the same act the *inbox's* Ship it already
       *   performs unattended (`resolveDeliveryFor`). Two buttons with one word on
       *   them, doing different things depending on which screen you were on, was the
       *   real inconsistency.
       * - **Not declared → the window, exactly as before.** Nothing is lost by a repo
       *   that has declared nothing, which is most of them, and the fallback is a
       *   supervised session that can read the repo's own rules and stop.
       *
       * The button says which of the two it will do before you press it — the board
       * carries `deployDeclared` and `deployHint` on every row for that, and the
       * deploying one is armed like Merge is, because the reason the old Ship needed
       * no guard was that you could watch the window and stop it.
       *
       * Ordering, as everywhere a deploy is started: a beadcause deploy SIGKILLs this
       * process. There is nothing to make durable first here — the merge already
       * happened, this endpoint writes no bead and closes no question — so the record
       * `startDeploy` puts on disk before it spawns is the only thing that has to
       * outlive the reply, and it does.
       *
       * Refused before it starts if the PR is not merged. Shipping an unmerged pull
       * request has no meaning, and a window that opens and then explains that to
       * itself is a window you have to go and close.
       */
      if (p === '/api/pr/ship' && req.method === 'POST') {
        // Same refusal as `/api/session` and `/api/deploy`, and for the stronger
        // version of both reasons: an observer on a spare port shares these checkouts,
        // and neither restarting the live daemon nor opening an unattended session in
        // a repo it is only visiting is a thing it should be able to do.
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const { ws, unit } = requireUnit(body);
        const where = whereLanded(unit.workspace, unit.repo);
        const row = await prBoardRow(unit, Number(body.number), { force: true });
        if (!row.merged) {
          return json(res, 409, { error: `#${row.number} is not merged yet — there is nothing to ship` });
        }

        // Asked again rather than trusted from the board: the row may be up to 25
        // seconds old, and a declaration that cannot be read must fail here — with the
        // parse error in it — rather than quietly falling back to a window, which
        // would answer a typo by opening something you then have to close.
        let plan;
        try {
          plan = deployFor(cfg, unit.key);
        } catch (err) {
          throw Object.assign(new Error(`${where} declares a deploy this cannot read — ${err.message}`), { status: 409 });
        }
        if (plan) {
          const already = runningFor(unit.key);
          if (already) {
            return json(res, 409, { error: `a deploy of ${where} is already running`, deploy: already });
          }
          const bead = (row.beads || [])[0]?.id || null;
          const rec = beginDeploy(bus, cfg, unit.key, {
            bead,
            reason: `Shipped #${row.number}${row.mergeCommit ? ` (${row.mergeCommit.slice(0, 8)})` : ''} from the PR board`,
          });
          console.log(
            `[deploy] ${where}: started ${rec.id} (pid ${rec.pid}) for #${row.number}${rec.restarts ? ' — this one restarts beadcause' : ''}`
          );
          return json(res, 200, { ok: true, via: 'deploy', deploy: rec, hint: deployHint(plan), number: row.number });
        }

        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });
        const opened = await openShipSession(cfg, ws, row, { dir: checkoutOf(unit) });
        console.log(`[beadcause] ship session for ${where} #${row.number} in ${opened.dir} (${opened.mode})`);
        return json(res, 200, { ok: true, via: 'session', ...opened, number: row.number });
      }

      /**
       * Say something on the pull request itself.
       *
       * Not `/api/comment`, which writes on a *bead* and puts an agent onto answering
       * it. This one goes to GitHub and stops there — it is the note you leave for
       * whoever reads the PR later, including yourself, and the reason it exists on
       * this board is that the alternative from a phone is opening GitHub.
       */
      if (p === '/api/pr/comment' && req.method === 'POST') {
        const body = await readBody(req);
        const { unit } = requireUnit(body);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'text is required' });
        const row = await prBoardRow(unit, Number(body.number));
        await pr.comment(checkoutOf(unit), row.number, text);
        console.log(`[beadcause] commented on ${unit.key} #${row.number}`);
        return json(res, 200, { ok: true, number: row.number });
      }

      if (p === '/api/respond' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        if (!body.id || !String(body.response || '').trim()) {
          return json(res, 400, { error: 'id and response are required' });
        }
        const response = String(body.response);
        // Whose answer this is. Null for a token caller, which is every caller that has
        // ever answered from a notification shade — see `actorFor`. Read once, at the
        // top, because one tap can write four things (the beads a "yes" files, a pull
        // request's verdict, the note on the work bead, the answer itself) and every one
        // of them is the same person doing the same thing.
        const who = actorFor(req);
        // The one thing that turns this handler from an ending into a handover: the
        // bead says the tapped option commissions work rather than settling it. The
        // id comes from the client and the *meaning* of it is read back off the bead
        // — see `optionById` in lib/decision.js for why the caller does not get to
        // declare its own answer non-closing. Nothing is looked up for a typed
        // answer, which names no option and is always an ending.
        /**
         * The fourth answer that writes something, and the only one that has to run
         * before the gate rather than after it.
         *
         * A sentence aimed at a pull request a resolver handed back is a commission by
         * what it *is* — it starts work rather than settling anything — and that has to
         * be true whether it arrived as a tap on the branch's own option (which says
         * `closes: false` and would be caught below) or as a bare sentence on a card with
         * only one branch waiting, which names no option at all and would otherwise close
         * the card that is about to report how the work goes. `bound` is "this answer was
         * for a branch", not "a window opened": a macOS refusal must leave the card there
         * to try again on, exactly as the tapped option would.
         *
         * Deciding it here is also what keeps the gate honest. `closeGate` asks whether bd
         * would refuse to close this bead, and refusing an answer that was never going to
         * close anything would be a 409 over a decision Adam had every right to make.
         */
        const resolving = await resolveSweepFor(ws, body.id, response, { option: body.option || null });
        /**
         * The fifth, and the second one that has to run before the gate.
         *
         * An answer that says "endorse bc-x" performs it — see `resolveEndorsementsFor`
         * for the two incidents where it did not. Before the gate for the same reason
         * `resolving` is: what it finds decides whether this answer may close anything.
         * An endorsement `bd` refused is an instruction that did not happen, and a card
         * that closes over one is the exact ending this fixes.
         */
        const endorsing = await resolveEndorsementsFor(ws, body.id, response);
        const shape = await answerShape(ws, body.id, body.option);
        /**
         * A sentence on a card where one of the buttons would have started work.
         *
         * Not a commission and not a close — it is *not an answer yet*, and that is the
         * whole of the change. bc-wy06 collected "Ship it" on a card whose affirmative
         * option was a commission, closed on it, and lost the instruction; the branch it
         * was about is still unmerged. The alternative considered and rejected was
         * matching the typed words against the option labels, which reads "ship it but
         * not yet" as a commission just as confidently as "ship it" — a commission may
         * not be discarded on a guess about what a sentence meant, and it may not be
         * *granted* on one either.
         *
         * `resolving.bound` is excluded because it already means "this sentence is an
         * instruction for a branch": it is a commission by what it is, decided above, and
         * asking Adam to confirm what he has just unambiguously done would be the same
         * discourtesy in the other direction.
         *
         * It rides the commission path deliberately rather than growing a third one.
         * What that path does — comment the answer, leave the bead open, and with
         * `stayInInbox` leave the `human` label on — is exactly what "put it back with
         * the options still there" requires, and the card is rebuilt from the bead, so
         * the options return by themselves.
         */
        /**
         * A sweep card is excluded, and not because it is awkward.
         *
         * It is the one card that has already decided this question for itself, in
         * `sweepAnswer`: its options are branch rows, a sentence that names one is bound
         * to that branch, and **a sentence naming neither is an ordinary answer** — you
         * are talking about the card rather than commissioning a branch off it. That is a
         * deliberate rule with a test on it, arrived at by people looking at this exact
         * shape, and a newer general rule does not get to overturn it by accident.
         *
         * `resolving.bound` cannot stand in for this: it is false both for "not a sweep
         * card" and for "a sweep card whose answer named no row", and those are precisely
         * the two cases that must part company here.
         */
        const sweepRec = readSweepCards()[body.id];
        const onSweepCard = !!sweepRec && sweepRec.workspace === ws.name;
        const ambiguous =
          !String(body.option || '').trim() && !resolving.bound && !onSweepCard && shape.anyCommission;
        /**
         * *Not yet* — the third thing an answer can mean, and the one the machinery used
         * to get exactly backwards.
         *
         * An option marked `defers: true` (lib/decision.js) answers without closing *and*
         * without handing anything over: the words go on the thread and nothing is put in
         * motion, because what you said was "not yet". bc-7qo.10 offered precisely that,
         * hinted "keeps this card on the list", and tapping it took the `human` label off
         * and dropped the bead into `bd ready`, where the next advocate tick opened a
         * worker window on the question that had just been deferred.
         *
         * It rides the commission path rather than growing a fourth one, for the same
         * reason the ambiguous answer does: what that path does — comment, no close, no
         * gate, and with `stayInInbox` the `human` label left alone — is already the whole
         * of "answered, and the bead has not moved". `resolving.bound` wins where both
         * somehow hold, because an instruction aimed at a branch is a fact about the
         * sentence rather than about the button, and it is decided above with a write
         * behind it.
         *
         * **And then it sets the card aside** — `setAside` below, the same record
         * `/api/dismiss` writes. That is bc-y9cof, and the failure it fixes is the one
         * this option was supposed to be *for*. Leaving the card in the inbox with its
         * options was read, correctly, as the app not having heard the answer: the next
         * sweep drew the identical question with "⟳ You answered this 1m ago" over it,
         * three options still asking to be tapped, and no way to tell it apart from a
         * card that had lost the answer. bc-xl7n.132 said "leave it open until 717 and
         * 719 have merged" and was back on the list a minute later, wanting the same
         * decision.
         *
         * A dismissal is exactly the missing half, because it already knows when to come
         * back: the gate when the bead has one, a new comment when it does not. "Leave it
         * open until both children merge" *is* the gate clearing, so the trigger the
         * dismissal picks on its own is the sentence the answer wrote. The `human` label
         * still stays on — the hiding is beadcause's, not the tracker's, which is what
         * lets the card return at all.
         */
        const deferring = !resolving.bound && shape.picked?.defers === true;
        /**
         * An endorsement this answer asked for and `bd` would not perform.
         *
         * It rides the `ambiguous` path exactly — `noteOnly`, so nothing about this bead
         * moves and the card comes back with its options — and for the same reason:
         * this is **not an answer yet**. bc-xl7n.76.3's acceptance criterion is that an
         * instruction to endorse a named bead either takes the marker off or is refused
         * *in a way that says so*, and is "never recorded as settled with the marker
         * still on". A 409 is the wrong refusal: the endorsements that did work are
         * already written by the time this is known, and a request that reports nothing
         * written would be lying about them. So the words go on the thread with
         * `endorsing.note` beside them naming every bead and what happened to it, and
         * the card stays on the list to be answered again.
         *
         * Only a **failure** does this. A bead that was already endorsed is `ok` with
         * nothing to do, and a sentence read as *declining* to endorse asked for no act
         * at all — neither is an instruction left undone.
         *
         * `resolving.bound` wins, as it does over a deferral and for the same reason: an
         * instruction aimed at a branch is decided above with a write already behind it,
         * and that card stays in the inbox to report how the branch goes regardless. A
         * *picked* commission does not win, and that asymmetry is the point — it takes
         * the `human` label off and hands the bead to an agent, so the card carrying the
         * failure would leave the inbox with nobody having read it.
         */
        const unendorsable = !resolving.bound && endorsing.stuck;
        const commission = resolving.bound || shape.picked?.closes === false || ambiguous || unendorsable;
        // Before anything is written, including the create below: would bd refuse
        // to close this bead at the end of it?
        //
        // *Answer & close* is a promise of both halves, and the half that used to
        // fail was the second one — after the comment had gone in, and after any
        // beads a "yes" had created. What came back to the phone was an error over
        // a question that had in fact been answered, so it got answered again.
        //
        // So the refusal happens here, having written nothing, and it is a 409
        // rather than a 500: the request was understood and refused for a reason
        // you can act on. `gate` carries that reason and the beads behind it, and
        // the phone offers to save the answer as a comment instead — which is the
        // half that was always going to work.
        // Deliberately no `force` escape hatch here. Skipping the check would only
        // reach the same refusal from bd a moment later, since `respond` does not
        // pass `--force` — a bypass that cannot bypass anything is a trap. Still true
        // after bc-ko7n: `closeAnswered` recovers from bd's claim guard by dropping the
        // assignee, which is not one of the refusals this gate reports and never reaches
        // the phone at all.
        // Skipped entirely for a commission, and not as an optimisation: there is no
        // close to be refused. A bead blocked by an open dependency can still be
        // *told what to do* — the gate is bd's rule about finishing work, and this
        // answer starts it.
        const gate = commission ? null : await bd.closeGate(ws, body.id);
        if (gate) {
          console.log(`[beadcause] ${ws.name}/${body.id} cannot be closed — ${gate.reason}; nothing written`);
          return json(res, 409, {
            error: `bd will not close ${body.id}: ${gate.reason}`,
            gate,
            // What the phone should offer instead. Named rather than inferred, so a
            // future gate that genuinely should block the comment too can say so.
            canComment: true,
          });
        }
        // The one place in beadcause where answering writes something other than a
        // comment: an advocate's proposal is a question whose "yes" is a create.
        // Deliberately before the close — if bd refuses the create, the question
        // stays open and you can answer it again, rather than being closed on a
        // promise that was never kept.
        const { created, declined, skipped } = await createProposed(
          ws,
          body.id,
          response,
          Array.isArray(body.create) ? body.create.map(Number).filter(Number.isInteger) : null,
          body.edits && typeof body.edits === 'object' ? body.edits : null,
          { actor: who }
        );
        // The other question whose answer writes something: an agent asking to change
        // what it is. Before the close for the same reason as the create above — a
        // commit that fails must leave the question answerable rather than closed on
        // a promise nothing kept.
        const amended = await resolveAmendmentFor(ws, body.id, response);
        // And the third: a worker's pull request, whose answer is the merge. Same
        // placement and the same reason — a merge GitHub refuses must leave the
        // question open, because a closed question is one you cannot answer again.
        const delivered = await resolveDeliveryFor(ws, body.id, response, { actor: who });

        const record = [
          created.length ? `Created: ${created.join(', ')}` : '',
          declined.length ? `Declined: ${declined.join('; ')}` : '',
          // On the thread beside what *was* created, so the record of this answer is
          // the whole of what happened rather than the part that went as asked.
          skipped.length ? `Already filed, so not created: ${skipped.join('; ')}` : '',
          amended.note,
          delivered.note,
          resolving.note,
          // What the answer said about endorsing other beads and what came of it —
          // always, including when nothing was endorsed, because "I read this and did
          // nothing" going unsaid is the whole of bc-xl7n.76.3.
          endorsing.note,
          // Said on the thread rather than left to be inferred from the labels: the
          // next reader of this bead is an agent that has to know it is being given
          // work, not shown a decision somebody else already acted on. A sweep card is
          // the one commission whose work is not a bead — it is a window on a branch —
          // so it says what it actually is instead.
          !commission
            ? ''
            : unendorsable
              ? 'Left open, and still yours — this answer asks for a bead to be endorsed and that could not be done, so the question has not been recorded as settled. Answer it again once the line above is dealt with.'
              : ambiguous
                ? 'Left open, and still yours — one of the choices here starts work rather than settling the question, and a typed answer cannot say which you meant. Your words are on the thread; pick an option to commit it.'
                : resolving.bound
                  ? 'Left open — this answer is an instruction for a branch, and this card reports how it goes.'
                  : deferring
                    ? // Said in as many words because the reader is an agent deciding whether
                      // it has been given work. "Handed back" here would be the sentence
                      // bc-7qo.10 collected, and it is the one that got a worker opened on a
                      // question that had just been put off. The second sentence is bc-y9cof:
                      // the card is off Adam's list now, so an agent that reads this bead and
                      // finds nothing happening must not conclude the question was dropped —
                      // it is waiting, and this says on what.
                      'Left open, and nothing has been handed to an agent — this answer defers the question rather than settling it or commissioning anything. The card is set aside in beadcause and comes back on its own when what it is waiting on has cleared.'
                    : 'Left open and handed back — this answer commissions the work rather than finishing it.',
        ].filter(Boolean);
        const answer = record.length ? `${response}\n\n${record.join('\n')}` : response;
        // An ambiguous answer writes the words and **nothing else** — `noteOnly` is a
        // comment and a mention sweep, with no status, label or assignee write anywhere
        // near it. That is the point rather than an economy: nothing was decided, so
        // nothing about the bead may move. `commission` would have been close enough to
        // look right — `stayInInbox` keeps the `human` label — but it also calls
        // `reopen`, which clears the assignee, and it records the sentence in the
        // answered store as though the question had been settled by it.
        //
        // `stayInInbox` below is therefore back to meaning only what it always meant: a
        // sweep card, which is still the only thing reporting on the window it started.
        //
        // A **deferral** is the second caller of `stayInInbox`, and the first one that is
        // not a sweep card. It wants the rest of `commission` — the answer on the thread,
        // no close, the bead open and unclaimed — and it wants the `human` label left
        // exactly where it is. Still true after bc-y9cof, and now for a sharper reason
        // than "the card staying on your list is the answer": the card is hidden by a
        // dismissal record, and `withoutDismissed` only keeps a record for a bead the
        // sweep still returns. Drop the label here and the bead leaves the sweep, the
        // record is pruned as stale, and the deferral becomes a bead that has quietly
        // left the inbox with nothing due to bring it back — the silent loss this app
        // exists to prevent, reached from the opposite direction.
        if (ambiguous || unendorsable) await bd.noteOnly(ws, body.id, answer, { actor: who });
        else if (commission)
          await bd.commission(ws, body.id, answer, { actor: who, stayInInbox: resolving.bound || deferring });
        else {
          await bd.respond(ws, body.id, answer, { actor: who });
          // Answered and closed on disk — so it must not be handed back by a sweep of
          // this repo that fails before the next one succeeds. The rows we hold for an
          // unreadable workspace stand in for an answer nobody could get; they are not
          // a record to argue with a write we have just made. See lib/sweep.js.
          sweeps.questions.forget(ws.name, body.id);
        }
        // And the layer above `sweeps` (bc-1kwl.7): all three branches above just wrote
        // to this workspace's `bd`, so the raw rows `allQuestions()` has kept for it are
        // wrong now, not merely old. Unconditional, not only in the `respond` branch —
        // a commission changes labels and an ambiguous answer changes the thread, and
        // either one served stale for up to `INBOX_FRESH_MS` would show the card as it
        // was before this request. `sweeps.questions.forget` above is the same argument
        // one layer down, for the workspace whose `bd` cannot even be asked right now.
        cacheDrop(`questions:${ws.name}`);
        /**
         * *Not yet* — and off the list, which is the half that used to be missing.
         *
         * After the comment rather than before it, and that ordering is load-bearing
         * twice over. `setAside` counts the thread to decide what a *new* comment would
         * be, so counting before our own answer went on would leave the baseline one
         * short — and for a bead with no gate a new comment is the whole trigger, so the
         * card would come straight back on the strength of the answer that sent it away.
         * And it is the answer that must not be lost, so it goes in first and this runs
         * after it: a read of `bd` that fails here costs a card left visible, where the
         * same failure before the comment would have cost the answer.
         *
         * Never for `resolving.bound`, which is excluded from `deferring` above: that
         * card is a branch reporting on itself and setting it aside would hide the
         * reports it exists to deliver.
         *
         * And never for `unendorsable` (bc-xl7n.76.3), which is the one that only shows
         * up where these two changes meet. That flag means the answer asked for a bead to
         * be endorsed, the endorsement failed, and the question has therefore *not* been
         * recorded as settled — its whole contract is that the card stays on the list to
         * be answered again. Hiding it here would leave an answer that the same response
         * already reports as not landed (`deferred: deferring && !unendorsable` below)
         * sitting behind a set-aside nobody asked for, with no card left to answer.
         */
        // Two fields, not one, and the second is not the first being null. A bead with
        // no gate is set aside perfectly well — a new comment is what brings it back —
        // so `deferredUntil: null` is the *ordinary* case and cannot also mean "this
        // failed". `deferredAside` is what the toast reads to decide whether the card
        // it is speaking over has gone anywhere.
        let deferredUntil = null;
        let deferredAside = false;
        if (deferring && !unendorsable) {
          try {
            const aside = await setAside(ws, body.id, { requireHold: true });
            deferredAside = aside.ok;
            deferredUntil = aside.gate?.reason || null;
            if (!aside.ok) {
              console.log(
                `[beadcause] ${ws.name}/${body.id} was deferred but not set aside — bd could not be read, so the card stays visible`
              );
            }
          } catch (err) {
            // Logged, not thrown, and the card stays visible. Same trade as the deploy
            // refusal further down: what has been written is written, and an answer
            // reported as a 500 is an answer given twice.
            console.error(
              `[beadcause] ${ws.name}/${body.id} was deferred but could not be set aside — ${err.message.split('\n')[0]}`
            );
          }
        }
        /**
         * And if this bead was held as a duplicate, the handover is what lifts that.
         *
         * Only on a commission, and only ever here. The card lib/superseded.js writes
         * has exactly one non-closing option — "keep it, not the same job" — so a
         * commission on a marked bead *is* Adam saying these are two jobs. Leaving the
         * marker on would hand back a bead nothing may open a session on, which is a
         * button that did not do what it said.
         *
         * After the answer rather than before it, and never allowed to fail it: the
         * answer is the thing that must not be lost, and a marker still on a bead is a
         * bead sitting quietly rather than a bead in the wrong queue.
         */
        // Not for an ambiguous answer: lifting the marker is Adam saying "these are two
        // jobs", and an answer we have just declined to read as a choice cannot be read
        // as that one either. The card comes back with its options, and the release
        // happens when he picks one.
        // Nor for a deferral, and for the same reason one step along: "not yet" is not
        // "these are two jobs" either. The superseded card's non-closing option is the one
        // that says they are different work; an answer that has deliberately changed
        // nothing about the bead cannot be read as having said it.
        // Nor for an answer whose endorsement failed, and for the third time the same
        // reason: nothing about this bead has been decided, so nothing about it moves.
        if (commission && !ambiguous && !unendorsable && !deferring) {
          try {
            const { released, supersededBy } = await release(bd, ws, body.id);
            if (released) {
              console.log(`[beadcause] ${ws.name}/${body.id} is no longer superseded by ${supersededBy} — you handed it back as work`);
            }
          } catch (err) {
            console.error(`[beadcause] ${ws.name}/${body.id} was handed back but keeps its superseded marker — ${err.message.split('\n')[0]}`);
          }
        }
        console.log(
          `[beadcause] answered ${ws.name}/${body.id}${who ? ` as ${who}` : ''}${
            unendorsable
              ? ' — left open in the inbox; it asks for an endorsement that could not be performed'
              : ambiguous
                ? ' — left open in the inbox; a typed answer cannot pick between options where one commissions work'
                : deferring
                  ? ` — deferred: nothing handed to an agent, and ${
                      // Off `deferredAside`, never off `deferredUntil`. A null `until` is
                      // the ordinary gateless case, so reading the sentence out of it would
                      // print "set aside, back on the next comment" directly under the line
                      // saying the set-aside did not happen — the log contradicting itself
                      // over the one card still sitting in front of him.
                      !deferredAside
                        ? 'the card stays on the list — it could not be set aside'
                        : deferredUntil
                          ? `the card is set aside, back when ${deferredUntil} clears`
                          : 'the card is set aside, back on the next comment'
                    }`
                  : commission
                    ? ' — left open and handed back as ready work'
                    : ''
          }`
        );
        /**
         * Write down what was said, for the day this bead comes back.
         *
         * The answer has just closed the bead, and a closed bead is out of the inbox —
         * but "closed" is not the end of the story for a decision whose chosen option
         * was *go and build it*: the session that picks the work up reopens the bead,
         * and a reopened bead still labelled `human` arrives again as a card with no
         * memory of this. See lib/answered.js for the whole failure and why the answer
         * is remembered here rather than looked up in `bd`.
         *
         * A commission is the fix for that loop rather than an exception to this: it
         * hands the bead over without ever closing it, so there is no reopen to bring
         * the card back. The answer is still written down, because "no reopen" is a
         * property of this answer and not of the bead — anything can label it `human`
         * again, and when it does, what you said should still be on the card.
         *
         * After the write and before the `answered` event, so the next poll — from
         * this phone or another client — already has it. The stored text is the answer
         * as you typed it, not the record line appended above it: the beads a "yes"
         * created are on the thread, and what belongs on a card is the sentence you
         * would recognise.
         */
        saveState({ answered: pruneAnswered(recordAnswer(loadState().answered, `${ws.name}/${body.id}`, response)) });
        // Tell every other client the card is gone before the poller notices, so
        // answering on the phone clears the notification on the tablet.
        bus.emit({ type: 'answered', key: `${ws.name}/${body.id}`, workspace: ws.name, id: body.id });
        unring(`${ws.name}/${body.id}`);
        /**
         * And the Slack message for it, rewritten with the answer and the buttons gone.
         *
         * Here rather than back in lib/slack.js, and that is the whole reason
         * `slackUser` is a field on this request. Every answer ends up in this handler
         * — the phone, an ntfy button, a Slack button — so settling in one place is the
         * only arrangement where the message cannot be settled twice, and the second
         * settle is the one that would find the registry entry already gone and print
         * "Answered" with no author over the answer somebody had just given.
         *
         * So the Slack caller says who pressed and this says it on the message. It is
         * cosmetic and it is checked as such: whose answer this is *on the bead* is
         * `actorFor` above, which is null for every token caller and always has been.
         *
         * Not awaited: an answer must not be held up by Slack, and a message one edit
         * late is what the sweep's own settle exists to catch.
         */
        {
          const by = typeof body.slackUser === 'string' ? body.slackUser.trim().slice(0, 64) : null;
          settleSlack(cfg, `${ws.name}/${body.id}`, {
            response,
            by: by || null,
            // "Set aside" on a deferral rather than "Deferred", and it is the same word
            // `/api/dismiss` settles with, because it is now the same outcome: the card
            // is off the list and nobody else should be able to answer it from a room.
            verb:
              ambiguous || unendorsable
                ? 'Said, not yet decided'
                : deferring
                  ? 'Set aside'
                  : commission
                    ? 'Handed back'
                    : 'Answered',
          }).catch((err) => console.error(`[slack] could not settle ${ws.name}/${body.id}: ${err.message}`));
        }

        /**
         * **Ship it**, and the reason this is the last thing in the handler.
         *
         * A beadcause deploy SIGKILLs beadcause — this process, holding this socket.
         * So every durable thing this answer owed is already done above: the merge is
         * on GitHub, the work bead is closed, the answer is written and the question is
         * closed, and every other client has been told. What is left is a command that
         * may end this process, and it is started only once nothing is riding on this
         * process surviving it. `startDeploy` returns as soon as the record is on disk
         * and the detached runner is spawned; the runner waits out `graceMs` before it
         * touches anything, which is what gets the reply below out of the socket.
         *
         * A refusal here is logged and written onto the question rather than thrown.
         * The merge has landed and cannot be un-landed by a 500, and an answered
         * question that reports failure is worth far more than an unanswered one.
         */
        let deploy = null;
        if (delivered.deploy) {
          try {
            deploy = beginDeploy(bus, cfg, delivered.deploy.key || delivered.deploy.workspace, {
              bead: delivered.deploy.bead,
              reason: delivered.deploy.reason,
            });
            console.log(
              `[deploy] ${whereOf(deploy)}: started ${deploy.id} (pid ${deploy.pid}) from ${ws.name}/${body.id}` +
                `${deploy.restarts ? ' — this one restarts beadcause' : ''}`
            );
          } catch (err) {
            console.error(`[deploy] ${delivered.deploy.key || delivered.deploy.workspace}: ship answered but no deploy started — ${err.message}`);
            // As beadcause, deliberately, unlike the answer above: this sentence is
            // the daemon reporting on what it just failed to do, and putting your
            // address on it would read as you having said it.
            await bd
              .comment(ws, body.id, `The merge landed. The deploy did **not** start: ${err.message}`)
              .catch(() => {});
          }
        }
        // The delivery question closes on every one of its four answers, including
        // "request changes" — the question was *merge this?* and it has been
        // answered. The next push files a new one, so the inbox carries one card per
        // attempt rather than one card that quietly changes meaning under you.
        return json(res, 200, {
          ok: true,
          // False on a commission, and the card still leaves the inbox — the two are
          // not the same fact. A client that reads this as "gone" is right either
          // way; one that reads it as "finished" would be wrong, which is why the
          // toast on the phone reads off this rather than off the tap.
          closed: !commission,
          // Both false together is the new third outcome, and it is the one combination
          // no client has seen before: the answer is on the thread and the card is still
          // in the inbox with its options. `handedBack` stays honest rather than being
          // stretched to cover it — an ambiguous answer hands nothing to anybody, and a
          // client told otherwise would stop showing the card that still needs a tap.
          // A deferral is excluded for exactly the reason an ambiguous answer is: nothing
          // was handed to anybody. Its card does leave the inbox now (bc-y9cof), but that
          // is `deferred`, `until` and `setAside` below saying so — a client told
          // `handedBack` would announce work starting over a question just put off.
          handedBack: commission && !ambiguous && !unendorsable && !deferring,
          // Additive, like `skipped` below: an older service worker and the installed
          // Android build have never heard of it, and their toast falls back to the
          // generic one rather than claiming something untrue.
          needsChoice: ambiguous,
          // The fourth combination, and the one that needs its own field rather than a
          // pair of falses: `closed` and `handedBack` and `needsChoice` are all false for
          // a deferral, which is indistinguishable from a client's point of view from a
          // failure that wrote nothing. Additive like the two above — a cached service
          // worker falls back to the plain "Answered", which is true as far as it goes.
          // False when the endorsement half of the same answer failed: a client
          // toasting "Deferred" over an answer that has not been recorded as one is the
          // same wrong message in a smaller font.
          deferred: deferring && !unendorsable,
          // What brings a deferred card back, in the gate's own words, or null for "the
          // next comment". Same field and same meaning as `/api/dismiss` returns, because
          // it is the same record — the toast says it, so the one thing you are not left
          // wondering is when a card you just sent away is due to reappear.
          until: deferredUntil,
          // Whether the card actually left the inbox. Read `until` for *when it returns*
          // and this for *whether it went*: they are independent, because a bead with no
          // gate is set aside on a null `until` and comes back on the next comment. A
          // client that inferred the second from the first would promise a return over a
          // card still sitting in front of you the one time the set-aside failed.
          setAside: deferredAside,
          created,
          declined,
          // Rows an approval asked for that already existed. Additive, like every other
          // field here: a cached service worker and the installed Android build have
          // never heard of it and must keep working.
          skipped,
          amendment: amended.result,
          delivery: delivered.result,
          // What this answer asked to endorse and what came of it — `null` for the
          // answer that named nothing, which is nearly every answer. Additive like
          // `deferred` above: a cached service worker has never heard of it.
          endorsement: endorsing.result,
          // Present only on a ship, and it means "written down and a process owns it",
          // never "it worked" — the same contract POST /api/deploy answers under.
          deploy,
        });
      }

      /**
       * Get rid of a question without answering it.
       *
       * The third thing you can do with a card, and the only one that writes nothing
       * but a full stop: the bead closes, and nothing else moves. Deliberately none
       * of what `/api/respond` does above — no proposal is created, no amendment
       * committed, no pull request merged — because "I am never going to answer
       * this" is not consent to any of them. A dismissed delivery leaves its PR open
       * on GitHub; a dismissed proposal creates no beads.
       *
       * The note is optional here, unlike `/api/respond`, where an empty answer is a
       * bug. Most dismissals have nothing to say, and demanding a sentence for them
       * is how a stale question stays in the inbox for a fortnight.
       */
      if (p === '/api/dismiss' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        if (!body.id) return json(res, 400, { error: 'id is required' });
        const note = String(body.reason || '').trim();
        const key = `${ws.name}/${body.id}`;

        // **A dismissal closes nothing.** It used to, and that was the wrong shape:
        // "I am not dealing with this now" is not "this is decided". The bead you
        // most want off the screen is the one bd will least let you close — an epic
        // with thirty open children — and closing it to clear the card would throw
        // away the thing it was tracking. So the acknowledgement lives here, in
        // beadcause's own state, and the tracker never hears about it.
        //
        // What it *does* owe the thread is anything you typed. That goes on as an
        // ordinary comment, because an agent watching reads comments; a wordless
        // dismissal writes nothing at all.
        await bd.noteOnly(ws, body.id, note, { actor: actorFor(req) });

        // The record, and what will bring the card back. Shared with a deferral,
        // which is the same act reached by a different button — see `setAside`.
        const { gate } = await setAside(ws, body.id, { note });
        console.log(
          `[beadcause] dismissed ${key} — ${
            gate ? `back when ${gate.reason} clears` : 'back on the next comment'
          }${note ? `; noted on the thread` : ''}`
        );

        // Same event as an answer, because it means the same thing to every other
        // client: that card is gone from the inbox. A tablet holding a notification
        // for it must drop the notification whether it was answered or set aside.
        bus.emit({ type: 'answered', key, workspace: ws.name, id: body.id });
        unring(key);
        // And for the same reason, the message in the channel. A card you have set
        // aside is not a card anybody else should still be able to answer — and it is
        // "Set aside" on the message rather than "Answered", because dismissing is the
        // one ending that writes no answer at all. The note is not repeated into the
        // channel: it was written for the thread, and a sentence explaining why you are
        // not answering something is not obviously a sentence for a room.
        settleSlack(cfg, key, { verb: 'Set aside' }).catch((err) =>
          console.error(`[slack] could not settle ${key}: ${err.message}`)
        );
        return json(res, 200, { ok: true, closed: false, dismissed: true, until: gate?.reason || null });
      }

      if (p === '/api/comment' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        if (!body.id || !String(body.text || '').trim()) {
          return json(res, 400, { error: 'id and text are required' });
        }
        await bd.comment(ws, body.id, String(body.text), { actor: actorFor(req) });
        // Commenting without answering means the ball is in an agent's court.
        // The label is the signal a session can actually find: `bd list --label=human-replied`.
        try {
          await bd.addLabel(ws, body.id, REPLIED_LABEL);
        } catch (err) {
          console.error(`[beadcause] could not flag ${ws.name}/${body.id}: ${err.message.split('\n')[0]}`);
        }
        // Baseline the thread on our own write — and this is now the *only* thing
        // stopping a self-notify here, not a belt beside a brace. `checkReplies`
        // filters on `cfg.actor`, and a comment from a signed-in browser is no longer
        // written as that, so a thread left unbaselined would buzz you with your own
        // sentence on the next tick.
        try {
          const n = (await bd.comments(ws, body.id)).length;
          hooks.rebaseline?.(`${ws.name}/${body.id}`, n);
        } catch {
          // The count could not be read — a Dolt lock, usually. We still know exactly
          // one comment went in, so move the baseline by one rather than leaving it
          // for "the next tick": the next tick is the thing that would notify you.
          hooks.countedOne?.(`${ws.name}/${body.id}`);
        }
        console.log(`[beadcause] commented on ${ws.name}/${body.id} — awaiting agent`);
        bus.emit({ type: 'commented', key: `${ws.name}/${body.id}`, workspace: ws.name, id: body.id });
        unring(`${ws.name}/${body.id}`);

        // Send someone to actually answer it. Fire-and-forget on purpose: the phone
        // gets its 200 immediately rather than holding the request open for a model
        // round trip, and the agent's reply arrives later through the normal push.
        let issue = null;
        try {
          issue = await bd.show(ws, body.id);
        } catch {
          /* the dispatch prompt can live without a title */
        }
        const q = issue ? toQuestion(ws.name, issue) : null;
        // Which agent you picked. An unknown or absent id resolves to the default
        // rather than refusing — a phone that hasn't refreshed its roster must still
        // get an answer.
        // Resolve the agent the same way the dispatcher will, so an unknown id can't
        // arm one agent and elevate another.
        const chosen = agentFor(cfg, body.agent ? String(body.agent) : null);
        const elevated = armedTools.has(chosen.id);
        // Awaited only for the foundation read the dispatcher does before spawning;
        // the agent itself is still fire-and-forget behind it.
        const dispatch = await dispatchReply(cfg, ws, body.id, q?.question || q?.title || '', {
          agentId: chosen.id,
          elevated,
          // The tracker, so the agent's own request to be changed can be filed at the
          // end of its run, and the issue, so a thread that *is* such a request gets
          // answered by the agent that filed it rather than by a roster persona.
          bd,
          issue,
        });
        // Consumed by the reply it was armed for — and only if one actually went.
        // A dispatch refused because auto-dispatch is off must not silently burn it.
        if (elevated && dispatch.dispatched) armedTools.delete(chosen.id);
        if (!dispatch.dispatched) console.log(`[beadcause] no agent dispatched for ${ws.name}/${body.id}: ${dispatch.reason}`);

        return json(res, 200, {
          ok: true,
          closed: false,
          awaitingAgent: true,
          dispatched: dispatch.dispatched,
          agent: dispatch.agent || null,
          elevated: Boolean(dispatch.elevated),
        });
      }

      if (p === '/api/status' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const key = `${ws.name}/${body.id}`;
        if (!body.id) return json(res, 400, { error: 'id is required' });
        const activity =
          !body.phase || body.phase === 'idle'
            ? (clearActivity(key), null)
            : setActivity(key, { phase: String(body.phase), detail: String(body.detail || ''), actor: body.actor || '' });
        bus.emit({ type: 'activity', key, workspace: ws.name, id: body.id, activity });
        return json(res, 200, { ok: true, activity });
      }

      /**
       * Everything the space picker needs, and nothing that costs a `bd` call.
       *
       * The picker is in the top bar of every standing view — the inbox, the PR board,
       * the advocate console, the chat launcher, the agents screen — and all of them
       * have to draw it identically, including the counts, or the same control would
       * report different numbers depending on which page you were on. The inbox gets
       * this on `/api/questions` already; this is the same three fields for the four
       * pages that never sweep the tracker.
       *
       * `spaces` and `counts` come off the last sweep (see `spacesPending`), so this is
       * a couple of variables and a `loadState`. It is safe to call on every page load
       * and on every repaint of the bar.
       *
       * The filter is reconciled on the way out for the same reason `/api/questions`
       * reconciles it — see `reconcileFilter`. A picker showing a space nobody has any
       * more is worse here than in the inbox, because on a page with no list under it
       * there is nothing at all to hint at why everything vanished.
       */
      if (p === '/api/spaces' && req.method === 'GET') {
        const saved = loadState();
        const names = scopedWorkspaceNames(saved);
        // Before the first sweep has landed there is nothing on file, and a picker
        // drawn from an empty list would put every space's workspaces under the
        // synthetic "Other" group for the few seconds until the poller finishes. The
        // shape of the spaces is config, not tracker — so ask config for it.
        // Narrowed to the account before anything is measured against it, for the
        // reason `inboxPayload` does the same: this is the picker's whole payload, and a
        // picker that offered the other account's spaces would be the one control on the
        // page able to leave it.
        const account = activeAccount(cfg, saved);
        const spaces = accountSpaces(account, spacesPending.length ? spacesPending : summarise(cfg, []));
        return json(res, 200, {
          spaces,
          workspaces: names,
          filter: reconcileFilter(spaces, names, saved.filter),
        });
      }

      /**
       * One space's own configuration — the read half of the space details screen.
       *
       * Separate from `/api/spaces` above, which is the picker's payload and is
       * fetched on every page load of every standing view: this is fetched only when
       * you are actually looking at a space, and it carries per-repo resolutions the
       * picker has no use for. Both are pure reads of `cfg` and neither costs a `bd`
       * call — see `spaceDetail`.
       *
       * A name that is not a configured space is a 404 rather than an empty body,
       * including the synthetic `Other` group the picker offers for repos in no space
       * at all. Those follow the global defaults and there is nothing to set on them,
       * which the screen has to say out loud rather than draw dead controls for.
       */
      if (p === '/api/space' && req.method === 'GET') {
        const name = String(url.searchParams.get('space') || '');
        const found = spaceDetail(cfg, name);
        if (!found) return json(res, 404, { error: `no space called ${name || '(none given)'}` });
        // `observing` rides along, the way it does on /api/prs. /config is a whole page of
        // controls whose only payload is this one — and an instance that only watches must
        // draw them disabled, because its `cfg` is the *acting* daemon's config file. A
        // second request for one boolean would be the page paying twice to say which Mac
        // it is on. `spaceDetail` stays a pure read of the config object and knows nothing
        // about it, which is why the flag is spread on here rather than inside it.
        return json(res, 200, { ...found, observing: OBSERVING });
      }

      /**
       * And the write half: change one space's settings from the phone.
       *
       * Four things this does that a plain config write would not.
       *
       * **It patches.** Only the keys in `settings` are touched and `null` clears one
       * back to the global default, so the screen sends one field per press and two
       * devices a poll apart cannot clobber each other's unrelated answers. What may
       * be sent at all is `SETTINGS` in lib/spaces.js — `name` and `workspaces` are
       * not on it, because moving a repo between spaces changes which questions may
       * reach you and is not a thing to do with a thumb.
       *
       * **It changes the running daemon, not just the file.** `applySettings` mutates
       * the space object inside the live `cfg`, which is the same object every push
       * decision reads (`quietReasonFor`), every delivery reads (`prPolicyFor`) and
       * every reply agent reads (`autoDispatchAllowed`). `saveConfig` is what makes it
       * survive a restart. Both halves, in that order, or the setting is a lie in one
       * direction or the other.
       *
       * **It refreshes the picker's cached summary.** `spacesPending` carries the 🔕
       * every page's dropdown draws, and it is only rebuilt on the poll — so muting a
       * space here and then looking at the bar would show it unmuted for up to thirty
       * seconds, on the one screen where you had just said otherwise.
       *
       * **An observer may not press it.** Its `cfg` is the real daemon's config file;
       * writing from here would change what the *other* process does at the next
       * restart while doing nothing at all to what it is doing now. Same guard, and
       * for the same reason, as `POST /api/admin`.
       */
      if (p === '/api/space' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const name = String(body.space || '');
        const space = (cfg.spaces || []).find((s) => s.name === name);
        if (!space) return json(res, 404, { error: `no space called ${name || '(none given)'}` });

        /**
         * A `workspace` in the body makes this the *repo row's* write instead — one of
         * the four in `WORKSPACE_SETTINGS`, which are the answers that do not group by
         * space (see `PER_WORKSPACE` in lib/spaces.js).
         *
         * The same route rather than one of its own, because the two are the same act
         * from the same card and the reply is the thing that matters: this returns
         * `spaceDetail`, and the repo rows are drawn from it, so a press on a repo and a
         * press on a space both come back with the whole card refreshed. A second
         * endpoint would have had to return the same payload to be useful, and would
         * then be the same endpoint with a different name.
         *
         * It must be a workspace *this space actually contains*: a body naming any repo
         * on the Mac would let the card in front of one space quietly change the answer
         * for another, and the screen has no way to show that it had.
         */
        const repo = body.workspace === undefined || body.workspace === null ? null : String(body.workspace);
        if (repo !== null && !(space.workspaces || []).includes(repo)) {
          return json(res, 400, { error: `${repo || '(none given)'} is not a repo in ${name}` });
        }

        let changed;
        try {
          changed = repo === null ? applySettings(space, body.settings) : applyWorkspaceSettings(cfg, repo, body.settings);
        } catch (err) {
          // The message is the whole point of refusing rather than dropping — it is
          // what the screen puts under the control you just pressed.
          return json(res, 400, { error: err.message });
        }

        if (changed.length) {
          saveConfig(cfg);
          console.log(`[beadcause] ${repo === null ? `space ${name}` : `repo ${repo}`}: ${changed.join(', ')} changed from the app`);
          // One row, and only the two flags this write can have moved. Deliberately not
          // a `summarise(cfg, [])` rebuild: that takes its counts from the questions it
          // is handed, so an empty list would zero every badge in the picker and drop
          // the synthetic "Other" group along with them.
          spacesPending = spacesPending.map((row) =>
            row.name === name ? { ...row, quiet: isQuiet(space), muted: Boolean(space.muted) } : row
          );
        }
        return json(res, 200, { ok: true, changed, ...spaceDetail(cfg, name) });
      }

      /**
       * Where a device is looking — the only thing a client tells us about itself.
       *
       * Posted by every page (see public/presence.js) when the view changes and as a
       * heartbeat while it stays put. The write is cheap on purpose: in memory, no
       * `bd`, no disk, because it happens every time a card opens on the phone and it
       * must never be the reason a tap feels slow.
       *
       * It only reaches the bus when it says something new. A heartbeat that repeats
       * the last report is stored and stays silent — otherwise every phone would wake
       * every parked long-poll twice a minute to say nothing had happened.
       */
      /**
       * The inbox's space/workspace filter, which is server-owned rather than
       * per-device on purpose.
       *
       * Two reasons it cannot live in localStorage: the notification path decides
       * whether to push from inside the server poll and has to read the same value,
       * and one human with a phone and a laptop should not have two devices
       * disagreeing about what is filtered. The accepted consequence is that changing
       * it on one changes it on the other.
       *
       * Deliberately not the scope setting (human / both / agent) — that stays in
       * localStorage, stays per-device, and stays out of the notification decision.
       */
      if (p === '/api/filter' && req.method === 'POST') {
        const body = await readBody(req);
        // Bounded as well as typed. The state file is rewritten by the poll every
        // thirty seconds, so an unbounded name from a junk body is a cost paid on
        // every tick forever; 120 characters is past any real space or workspace name.
        const pick = (v) => (typeof v === 'string' && v && v.length <= 120 ? v : 'all');
        const filter = { space: pick(body.space), workspace: pick(body.workspace) };
        saveState({ filter });
        // Notifications already unread for beads the new filter excludes stay unread,
        // silently, until the filter is widened again. There used to be a prompt on the
        // inbox offering to clear them; bc-ka5y.1 took it out along with everything
        // behind it, so a filter change now says nothing about the shade at all.
        return json(res, 200, { ok: true, filter });
      }

      /**
       * The accounts, and which one is in force — the read half of the switcher in the
       * top bar (public/accountbar.js).
       *
       * Every payload that draws a list already carries these two fields, so this route
       * exists for the pages that draw no list at all: the terminal, the graph, a
       * document. Cheap in the same way `/api/spaces` is — a `loadState` and a walk of
       * the config, with no `bd` and no disk read anywhere near it.
       */
      if (p === '/api/accounts' && req.method === 'GET') {
        const saved = loadState();
        return json(res, 200, {
          account: activeAccount(cfg, saved)?.email || null,
          accounts: accountRoster(cfg, saved, [...workspaces.keys()]),
          // Every workspace on the Mac, not the scoped list: this is what the
          // add-an-account form is built from, and a form that could only offer the
          // workspaces you can already see could never be used to reach the others.
          workspaces: [...workspaces.keys()],
          // Which checkouts each multi-repo workspace has approved, so the form can ask
          // the second-grain question for the one workspace that needs it. Absent for
          // every workspace that is one repo, which is all of them but that one.
          repos: approvedRepos(),
          // What the chip falls back to when no account is configured — this Mac's own
          // address, which is what a filing is stamped with today.
          me: meHandles(cfg)[0] || null,
        });
      }

      /**
       * Switch account. The one write behind "Switch accounts" in the menu.
       *
       * Server-owned like the filter below it and for the same two reasons: the push
       * path reads it from inside the poll with no client in the loop, and one person
       * with a phone and a laptop should not have two devices disagreeing about which
       * life they are in. The accepted consequence is the same one — switching on the
       * laptop switches the phone.
       *
       * An address that names no account is refused rather than stored. A stored value
       * naming nothing resolves to the first account (`activeAccount`), so accepting one
       * would put you somewhere you did not ask for and leave a value on disk claiming
       * otherwise.
       */
      if (p === '/api/account' && req.method === 'POST') {
        const body = await readBody(req);
        const account = accountFor(cfg, body.email);
        if (!account) return json(res, 400, { error: 'no such account' });
        saveState({ account: account.email });
        // Identity follows the account, and this process is the long-lived one: the
        // config was ordered at load (`accountHandles` in lib/config.js) and would go on
        // stamping the account you were in an hour ago without this. The byline is
        // derived once in `Bd`'s constructor rather than per call, so it is recomputed
        // here beside the list it reads. See lib/accounts.js and lib/byline.js.
        cfg.me = accountHandles(cfg, loadState());
        bd.me = cfg.me;
        bd.actor = bylineFor(cfg);
        console.log(`[beadcause] account switched to ${describeAccount(account)}`);
        const saved = loadState();
        return json(res, 200, {
          ok: true,
          account: account.email,
          accounts: accountRoster(cfg, saved, [...workspaces.keys()]),
        });
      }

      /**
       * Add an account, or rewrite one that exists — the ＋ in the picker, and the
       * checkboxes behind a row on it.
       *
       * **Adding the first one adds two**, which is the whole of why this goes through
       * `withAccount` rather than pushing onto an array. Until now every workspace was in
       * scope; somebody adding "Work — architecture" has said nothing about the eight
       * repos that are not it, and appending only what they typed would leave those
       * belonging to no account and visible from nowhere. So this Mac's own address is
       * materialised beside it, owning the rest. See lib/accounts.js.
       *
       * It writes the config, which the common repo snapshots on every write
       * (lib/commonrepo.js) — so a split made from a phone on a train is reviewable
       * afterwards, and recoverable if it was made wrong.
       */
      if (p === '/api/accounts' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const email = normalizeEmail(body.email);
        // Shaped like an address, and bounded. Not validated any harder than that: here
        // an address is a name rather than a credential, and a daemon refusing somebody's
        // perfectly good `+tag` address would be inventing a rule nothing needs.
        if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 120) {
          return json(res, 400, { error: 'a valid email address is required' });
        }
        cfg.accounts = withAccount(
          cfg,
          { email, label: body.label, workspaces: body.workspaces, repos: body.repos },
          { implicit: meHandles(cfg)[0] || null, known: [...workspaces.keys()] }
        );
        // An account you file as is an address you answer to. Added to `me` so a bead
        // another machine addresses to it is recognised here as yours — the list is what
        // `addressedElsewhere` tests, and an account missing from it would be stamped
        // onto writes by this daemon and then read back by the same daemon as somebody
        // else's. Appended rather than prepended: which one is *first* is the account's
        // to decide, on every load and on every switch.
        if (!meHandles(cfg).includes(email)) cfg.me = [...meHandles(cfg), email];
        saveConfig(cfg);
        // Selected on the way in when nothing was selected before, so adding your first
        // account and then having to switch to it is not two taps for one intention.
        if (!accountFor(cfg, loadState().account)) saveState({ account: email });
        // And the same identity refresh the switch does, for the case this add *was* one:
        // the first account added is selected on the way in, so the daemon would
        // otherwise go on stamping whatever `me` happened to be typed in first.
        cfg.me = accountHandles(cfg, loadState());
        bd.me = cfg.me;
        bd.actor = bylineFor(cfg);
        const saved = loadState();
        console.log(`[beadcause] account saved: ${email} (${cfg.accounts.length} configured)`);
        return json(res, 200, {
          ok: true,
          account: activeAccount(cfg, saved)?.email || null,
          accounts: accountRoster(cfg, saved, [...workspaces.keys()]),
        });
      }

      /**
       * Forget an account. Removing the last one turns the scoping off altogether and
       * puts every workspace back on every screen — the state this install was in before
       * the first one was added, and a way back that does not need the config file
       * opening on the Mac.
       */
      if (p === '/api/accounts' && req.method === 'DELETE') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        // The address from the query as well as the body, because a DELETE carrying one
        // is the request shape with the least agreement between clients: Node's own HTTP
        // server refuses a chunked DELETE body outright (an empty 400, before any of this
        // runs), and a WebView is not obliged to send one either. `fetch` does, which is
        // what the picker uses; the query is what makes the route reachable from anything
        // that does not.
        const body = await readBody(req).catch(() => ({}));
        const gone = accountFor(cfg, url.searchParams.get('email') || body.email);
        if (!gone) return json(res, 400, { error: 'no such account' });
        cfg.accounts = withoutAccount(cfg, gone.email);
        saveConfig(cfg);
        // The stored selection is left naming a dead address on purpose: `activeAccount`
        // resolves it to the first surviving account, and clearing it here would be a
        // second writer of that value racing the poll that reads it.
        console.log(`[beadcause] account removed: ${gone.email}`);
        const saved = loadState();
        return json(res, 200, {
          ok: true,
          account: activeAccount(cfg, saved)?.email || null,
          accounts: accountRoster(cfg, saved, [...workspaces.keys()]),
        });
      }

      if (p === '/api/presence' && req.method === 'POST') {
        const body = await readBody(req);
        const out = presence.report(body.device, body);
        if (!out) return json(res, 400, { error: 'device is required' });
        if (out.changed) {
          bus.emit({ type: 'presence', device: out.record.device, view: out.record.view, key: out.record.key });
        }
        return json(res, 200, { ok: true, seq: bus.seq });
      }

      if (p === '/api/presence' && req.method === 'DELETE') {
        const body = await readBody(req);
        if (presence.forget(body.device)) bus.emit({ type: 'presence', device: String(body.device), view: null });
        return json(res, 200, { ok: true, devices: presence.list() });
      }

      if (p === '/api/presence' && req.method === 'GET') {
        return json(res, 200, { devices: presence.list() });
      }

      /**
       * Which file a session is about to edit — and who else is already on it.
       *
       * Posted by the `PreToolUse` hook in `scripts/claim-guard.sh` on every Write and
       * Edit on this Mac, which makes this the hottest write in the daemon and sets what
       * it may cost: a map write, no `bd`, no disk, no bus. It is in the path of every
       * edit in every session, so a slow answer here is felt as a slow agent everywhere.
       *
       * **The asking is the taking.** `claims.claim()` decides and records in one
       * synchronous call, which is the whole race guarantee — see its header, and
       * lib/resolvers.js for the same property bought with a lock instead.
       *
       * Deliberately not on the bus. The poll below treats any event that is not
       * `presence` as a reason to sweep `bd`, so an event per claim would hang a tracker
       * sweep off every edit anybody makes; and nothing follows claims the way the mirror
       * follows presence. `GET` is how you read them.
       */
      if (p === '/api/claims' && req.method === 'POST') {
        const body = await readBody(req);
        const out = claims.claim(body.session, body);
        if (!out) return json(res, 400, { error: 'session, repo and file are required' });
        // Which bead this branch is for, if nobody has worked it out yet. Deliberately
        // not awaited: it is a `bd` spawn the first time a branch is seen and nothing on
        // this path may wait for one. It writes itself onto the records when it lands,
        // which is in time for every reader — a refusal names the *holder's* bead, and a
        // holder claimed its file before the session colliding with it arrived.
        if (!out.record.bead) branchBeads.follow(out.record.repo, out.record.branch);
        // Which lines each side has changed — git, so it is spawned on the refusal path
        // only. `claim()` above has already decided and recorded by the time this runs,
        // so the await cannot widen the window two racing claims see. Null whenever git
        // cannot answer, and the refusal falls back to its plain wording.
        const spans = out.decision === 'conflict' ? await regions.regionsForClaim(out) : null;
        // One line per collision and none per ordinary claim: this runs thousands of
        // times a day and only the collisions are worth a log.
        if (out.decision === 'conflict' || out.insisted) {
          const who = out.holders.map((h) => h.branch || h.session).join(', ');
          console.log(
            `[beadcause] ${out.insisted ? 'claimed anyway' : 'claim refused'}: ${out.record.label}/${out.record.file}` +
              ` wanted by ${out.record.branch || out.record.session}, held by ${who}${out.sameTree ? ' IN THE SAME WORKTREE' : ''}` +
              `${spans && spans.overlap ? ' — OVERLAPPING LINES' : ''}`
          );
        }
        return json(res, 200, {
          ok: true,
          decision: out.decision,
          insisted: out.insisted,
          sameTree: out.sameTree,
          holders: out.holders,
          regions: spans,
          reason: out.decision === 'conflict' ? claims.refusalFor(out.record.file, out, spans) : '',
        });
      }

      if (p === '/api/claims' && req.method === 'DELETE') {
        const body = await readBody(req);
        const files = Array.isArray(body.files) ? body.files : null;
        const released = claims.release(body.session, { files });
        if (released) console.log(`[beadcause] released ${released} file claim(s) for session ${body.session}`);
        return json(res, 200, { ok: true, released });
      }

      /**
       * Every live claim, and the files more than one session is holding.
       *
       * `?regions=1` adds the line ranges each side of a collision has changed, and it is
       * opt-in rather than default because it is several git spawns per collision and this
       * endpoint is cheap enough today to be polled. A reader that wants the detail asks
       * for it; one drawing a list of names pays nothing for a column it is not showing.
       */
      if (p === '/api/claims' && req.method === 'GET') {
        const found = claims.collisions();
        const withRegions =
          url.searchParams.get('regions') === '1'
            ? await Promise.all(found.map(async (c) => ({ ...c, regions: await regions.regionsForCollision(c) })))
            : found;
        return json(res, 200, { claims: claims.list(), collisions: withRegions });
      }

      /**
       * The requirement graph, and — the part that matters — how much of it is missing.
       *
       * bc-fvmx.8. A screen that listed requirements and the files carrying them, with no
       * denominator, would be read as an index of the codebase and would be silently wrong
       * about everything it omitted. So the payload leads with coverage: how many of the
       * corpus's requirements have any edge at all, how many of those a merge actually
       * proved, and how many ids are recorded that the corpus no longer has.
       *
       * `?id=` drills into one requirement and returns its edges. Everything else is the
       * summary, which is what the card draws.
       *
       * `{ corpus: null }` on an install with no architecture checkout — which is every
       * personal one. That is a state and not an error, so it is a 200 saying so rather
       * than a 404 the client has to interpret.
       */
      if (p === '/api/requirements' && req.method === 'GET') {
        const where = requirementsCorpus();
        if (!where) return json(res, 200, { corpus: null, tokens: [], totals: null, orphans: [] });
        const corpus = loadCorpus(where);
        const id = url.searchParams.get('id');
        if (id) {
          const entry = requirement(corpus, id);
          return json(res, 200, { corpus: where, id, requirement: entry, edges: await edgesFor(id) });
        }
        const graph = await everything();
        const cov = coverage(corpus, graph);
        // The graph rides along with the summary because the page drills into one token
        // without a second request, and the whole of it is a few hundred edges — smaller
        // than one screen of the ledger. If it ever is not, the drill-down becomes
        // `?token=` and this drops out; nothing else reads it.
        return json(res, 200, {
          corpus: where,
          dir: corpus.dir,
          ...cov,
          graph,
          // Ids the corpus itself defines twice. Distinct from `orphans` and worth keeping
          // apart: an orphan is an edge pointing at an id that has gone, this is two
          // definitions competing for an id that is there — and the loser is invisible
          // everywhere else, so this screen is the only thing that can say so.
          duplicates: corpus.duplicates || [],
          summary: describeCoverage(cov),
        });
      }

      /**
       * The control graph, and — the part that matters — every control it cannot evidence.
       *
       * bc-eqn1.3, and the internal-audit instrument the bead asked for. `/api/requirements`
       * above leads with a denominator so a partial index is not read as an index of the
       * codebase; this one leads with four **lists**, because a compliance finding is a
       * task with a name on it rather than a percentage:
       *
       * - `unevidenced` — every control with no edge at all;
       * - `forecastOnly` — a bead said it would, no merge has shown it did;
       * - `stale` — proved, but the newest proof is older than the review period;
       * - `orphans` — edges recorded against ids the corpus no longer has.
       *
       * **There is no `{ corpus: null }` branch here and that is the difference from
       * `/api/requirements`.** The requirements corpus lives in a checkout most installs do
       * not have, so its absence is a state to report. lib/controls.js ships with beadcause
       * and is built at import: an unreadable control corpus is a failed import, not a
       * payload. The route can therefore always state a denominator, which is exactly what
       * makes "137 controls have no evidence" a sentence anybody can act on.
       *
       * `?id=` drills into one control and returns its record, its crosswalk both ways, and
       * its edges. `?months=` measures staleness against a different observation window,
       * because a report over a quarter should not be told a year is current.
       */
      if (p === '/api/controls' && req.method === 'GET') {
        const c = controlCorpus();
        const id = url.searchParams.get('id');
        if (id) {
          const record = control(id);
          if (!record) return json(res, 404, { error: `${id} is not a control this corpus has` });
          return json(res, 200, {
            id: record.id,
            control: record,
            crosswalk: crosswalk(record.id),
            satisfiedBy: satisfiedBy(record.id),
            edges: await controlEdgesFor(record.id),
          });
        }
        const asked = Number.parseInt(url.searchParams.get('months') || '', 10);
        const graph = await controlGraph();
        const cov = controlCoverage(graph, Number.isInteger(asked) && asked > 0 ? { reviewMonths: asked } : {});
        return json(res, 200, {
          size: c.size,
          crosswalkEdges: c.edges,
          ...cov,
          // The graph rides along for the same reason it does on `/api/requirements`: the
          // page drills into one framework without a second request, and the whole of it is
          // a few hundred edges at most — smaller than one screen of the ledger.
          graph,
          summary: describeControlCoverage(cov),
        });
      }

      /**
       * The skill library, its candidates, and whether anything uses it — bc-dgx7.5.
       *
       * The scope is the ledger's, not a scope of its own: `?workspace=` or `?space=`,
       * defaulting to every workspace this account can see. `ledgerWorkspaces` is what
       * decides it, so an unknown workspace is a 400 and an unknown space a 404 here for
       * the same reasons they are on `/api/history`, and the History tab's picker can hand
       * this page its selection unchanged.
       *
       * **The half of the payload that is missing is in the payload.** Four of the six
       * numbers this view was asked for are downstream of an instrumented skill call, and
       * nothing records one yet — so `untracked` names them, says why, and names the bead.
       * A screen that dropped them would be read as a complete one. See lib/skills.js.
       *
       * Kept 30 seconds per scope and `refresh=1` for the ⟳, because the cost is three
       * `git` calls per checkout plus one `bd list` per workspace — nothing on a
       * forty-repo workspace, repeated on every paint.
       */
      if (p === '/api/skills' && req.method === 'GET') {
        const { picked, workspace, space } = ledgerWorkspaces(url.searchParams);
        const key = `skills:${picked.map((w) => w.name).join(',')}`;
        const got = await cacheRead(key, () => skillsView(bd, cfg, picked), {
          freshMs: 30_000,
          refresh: url.searchParams.get('refresh') === '1',
        });
        // Age on the header rather than in the body — the convention /api/history set.
        res.setHeader(KEPT_HEADER, describeKept(got));
        const body = got.value;
        // A refresh that failed over a kept answer: the answer stands, and what went wrong
        // joins the sentences the page already has somewhere to put.
        const errors = got.error ? [...(body.errors || []), got.error] : body.errors || [];
        return json(res, 200, { workspace, space, ...body, errors });
      }

      /**
       * Long-poll change feed. Hand back `seq` from the last response as `since`
       * and the request parks until something happens or `wait` seconds elapse.
       *
       * `questions` is only included when there is something to say — a timed-out
       * poll must not cost a `bd human list` across every workspace, which is the
       * whole reason this exists instead of the phone re-fetching on a timer.
       * `resync: true` means the caller was away longer than the event log and
       * should trust `questions` over its own state.
       */
      if (p === '/api/poll' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        // A watcher that only wants to be woken — the monitor's mirror, which reads
        // presence and nothing else. Without it, parking a second listener here would
        // double the `bd` sweeps the daemon does per event, to build a question list
        // that watcher throws away.
        const wantsQuestions = url.searchParams.get('want') !== 'presence';
        // A `since` from the future means the daemon restarted and the counter went
        // back to zero. Without this the phone would park forever waiting for a
        // sequence that can never arrive, and go deaf until the server caught up.
        if (since > bus.seq) {
          const fresh = wantsQuestions ? splitChannels(await allQuestions()) : null;
          return json(res, 200, {
            seq: bus.seq,
            resync: true,
            events: [],
            workspaces: scopedWorkspaceNames(),
            // Unconditional, unlike `questions`/`requests` below — see `currentStuck`.
            // A resync is exactly the case bc-ka5y.15.8 is about: the daemon restarted,
            // its event log has nothing left to replay, and this is the one thing that
            // still can say whether a tracker or a deploy is still stuck.
            stuck: currentStuck(),
            ...(fresh
              ? await inboxPayload(fresh.questions, fresh.requests, ['questions'])
              : { questions: null, requests: null, spaces: null }),
            advocates: scopedAdvocates(),
            observing: OBSERVING,
            presence: presence.list(),
          });
        }
        const cold = !url.searchParams.has('since');
        const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait') || 25), 0), 55) * 1000;

        if (!cold && waitMs > 0) {
          const parked = bus.wait(since, waitMs);
          // A phone that walks off the tailnet mid-poll leaves the socket half
          // open; without this every reconnect would strand a waiter.
          res.on('close', parked.cancel);
          await parked.promise;
          res.off('close', parked.cancel);
          if (res.writableEnded || req.destroyed) return;
        }

        const events = cold ? [] : bus.since(since);
        const resync = events === null;
        // Presence deliberately does not count as a change here. It wakes the poll —
        // that is the point, the mirror wants the phone's move immediately — but a
        // card opening on the phone says nothing about the tracker, and sweeping six
        // workspaces with `bd` every time a thumb moves would make the cheapest event
        // in the system the most expensive one.
        const changed = wantsQuestions && (cold || resync || events.some((e) => e.type !== 'presence'));
        const polled = changed ? splitChannels(await allQuestions()) : null;
        return json(res, 200, {
          seq: bus.seq,
          resync,
          events: events || [],
          workspaces: scopedWorkspaceNames(),
          // Unconditional, and not gated on `changed` like `questions`/`requests` — see
          // `currentStuck`. A poll that timed out with nothing new on the bus is exactly
          // the poll a phone makes after a reboot lost its tray with the tracker still
          // broken, and gating this on "did anything happen" is the bug bc-ka5y.15.8 is.
          // Cheap enough to always ask: no `bd` call, an in-memory map and a handful of
          // small files already read every cycle.
          stuck: currentStuck(),
          // The whole inbox screen when something moved, and null when nothing did.
          //
          // Null rather than [] for `questions` and `requests`, and absent rather than
          // stale for the rest: an empty array means "the channel is empty", and a poll
          // that timed out never asked. A watcher that confused the two would clear the
          // pane on every quiet minute. The fields beyond the two lists — the filter,
          // the counts, the notification prompt — arrive with them for the reason
          // `inboxPayload` exists: a page that refreshed itself from this used to have
          // to sweep `bd` a second time to get them, which is the cost this removes.
          ...(polled
            ? await inboxPayload(polled.questions, polled.requests, ['questions'])
            : { questions: null, requests: null, spaces: null }),
          // Always, not only when the questions changed: an advocate moves on its
          // own — a session it opened finishes, a slot frees — and the monitor
          // would otherwise show a stale picture until a question happened to move.
          advocates: scopedAdvocates(),
          observing: OBSERVING,
          // Same reasoning, and the mirror's whole input: it follows this list, so it
          // must arrive on the poll that woke for it rather than a tick later.
          presence: presence.list(),
        });
      }

      /**
       * A merge that happened in another process, so the phone hears about it anyway.
       *
       * Every other landing is the merge queue's, and the queue runs inside this daemon
       * where the bus is a function call away. `bin/deliver.js` is the exception: it is
       * a worker's own process, it still records a branch that was **already merged on
       * github.com** when the delivery started (`landHere`, `external: true`), and it
       * has no bus at all. Until bc-ka5y.15.1 it reached the phone by posting to ntfy,
       * which is exactly the arrangement that bead removes.
       *
       * So it posts here instead, the same way `bin/endorse.js` posts its endorsements
       * rather than writing them behind the daemon's back. Three properties worth
       * keeping if this is ever touched:
       *
       * - **The token, not a browser session.** `hasToken` explicitly, so a signed-in
       *   tab cannot put a card on the phone; this door exists for a CLI on the same
       *   Mac and nothing else.
       * - **The event is composed here, from named fields.** The body cannot choose its
       *   own `type` or hand over a ready-made event — `landedEvent` builds it — so the
       *   worst a wrong caller can do is announce a landing that did not happen, rather
       *   than forge any event on the bus.
       * - **Failing is not fatal to the caller.** A landing is true whether or not a
       *   phone in another room hears about it, which is why `bin/deliver.js` logs a
       *   refusal here and exits 0 regardless.
       */
      if (p === '/api/landed' && req.method === 'POST') {
        if (!hasToken(req, url)) return json(res, 403, { error: 'this door takes the token, not a sign-in' });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const number = Number(body.number);
        if (!Number.isInteger(number) || number <= 0) return json(res, 400, { error: 'number must be a pull request number' });
        const event = landedEvent(
          {
            workspace: ws.name,
            bead: String(body.bead || '').slice(0, 64),
            repo: String(body.repo || '').slice(0, 200),
            number,
            url: String(body.url || '').slice(0, 500),
            title: String(body.title || '').slice(0, 300),
            base: String(body.base || 'main').slice(0, 200),
            sha: String(body.sha || '').slice(0, 64),
            owed: String(body.owed || '').slice(0, 300),
          },
          { quiet: mutedNews(cfg, ws.name) }
        );
        bus.emit(event);
        return json(res, 200, { ok: true, key: event.key, quiet: event.quiet });
      }

      /**
       * Open a Claude session on the Mac to talk this question through.
       *
       * The only endpoint that starts a process rather than running `bd` with fixed
       * arguments, so it is the only one where the request body could become a
       * command. Two guards: the workspace must be one we already serve, and the id
       * has to look like a bead id before it goes anywhere near a shell. The title
       * is *not* taken from the request — it is read back from `bd`, so a crafted
       * body can't put text on the command line.
       *
       * **This is the one door that endorses rather than refuses.** Nothing else may
       * open a session on an unendorsed bead (lib/endorse.js), but you tapping it is
       * you present and choosing, so the tap takes the marker off and then opens — a
       * refusal here would send you to another screen to press a button and come back.
       * The endorsement goes first and stands even if iTerm then fails: you asked for
       * this bead to be worked, and that is true whether or not the window came up.
       */
      if (p === '/api/session' && req.method === 'POST') {
        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });
        // The one button you press whose consequence is unattended: an hour of
        // agent in a checkout this instance is only visiting. See lib/config.js.
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });

        const issue = await bd.show(ws, id);
        if (!issue) return json(res, 404, { error: 'not found' });
        const q = toQuestion(ws.name, issue);

        // No write at all unless the bead was actually held, so the ordinary tap on an
        // ordinary question costs nothing.
        const { endorsed } = await endorse(bd, ws, issue);
        if (endorsed) console.log(`[beadcause] endorsed ${ws.name}/${id} — you opened a session on it`);

        // The row goes in as well as the id and the title: in a workspace with an
        // approved repo list it is the bead's `repo:` label that decides which checkout
        // this window comes up in, and this route has already read it.
        const { dir, mode, repo } = await openSession(cfg, ws, id, q.question || q.title, issue);
        console.log(
          `[beadcause] opened a session on ${whereLanded(ws.name, repo)}/${id} in ${dir} (permission mode: ${mode})`
        );
        return json(res, 200, { ok: true, dir, mode, repo, endorsed });
      }

      /**
       * The third door: open the **successor to a handoff**.
       *
       * `/handoff` (the skill on this Mac) used to end by driving iTerm with AppleScript
       * through `~/.claude/open-handoff.sh`. This is what it asks instead, so the window
       * is one the daemon opened and knows about — it shows up in `liveSessions`, on the
       * console, and under the same duplicate guard as everything else.
       *
       * It is a third door and not a reuse of either of the two above, and that is the
       * substance of bc-ol4d rather than a preference:
       *
       *   - `POST /api/bead/advocate` answers **409 for every handoff there has ever
       *     been**. `wantsAdvocate` needs a root carrying an `owner:` label; the skill files
       *     handoffs as `--type=task --priority=1` and never claims them, deliberately,
       *     because a handoff is the top of the next session's queue, not an epic on the board.
       *   - `POST /api/session` would take it — and brief it wrong. `promptFor` opens with
       *     *"don't answer it on my behalf … we'll decide together"* and closes with
       *     `bd close --reason "Answered in a Claude session"`. A successor briefed that
       *     way discusses the handoff and marks it answered instead of doing the work.
       *     That failure is worse than the 409 because it looks like it worked.
       *
       * The guards are the two doors' guards, minus the four the advocate has and plus one:
       *
       *   - **`labels` must carry `handoff`.** `handoffPromptFor` says "continue this
       *     handoff, from its `## Next action`", which is only true of a handoff; pointed
       *     at an ordinary bead it is a brief about a section that isn't there. A 409 here
       *     costs nothing, because the caller falls back to iTerm and still opens.
       *   - **Never two on one handoff**, through the same `advocateSession` the epic door
       *     uses. It asks "is a live session named after this bead, or did we launch one
       *     in the last minute" and nothing about advocacy, which is exactly the question
       *     here: a `/handoff` retried after a slow launch must not open a second window
       *     onto the same work.
       *
       * It endorses, for `POST /api/session`'s reason and not out of symmetry: a handoff
       * bead was filed by an agent moments ago and is therefore held, and the person who
       * ran `/handoff` is present and asking for it — sending them to another screen to
       * press a button before their own successor may open would be absurd.
       */
      if (p === '/api/handoff' && req.method === 'POST') {
        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });

        // `loadBead` and not a bare `bd.show` + null check: bd *throws* for an id it does
        // not have, so the null check never fires and the id that is gone comes back a 500
        // carrying bd's whole command line — the actor's email address included — in the
        // error body. That is what this door answered before the fix, and the caller falls
        // back to iTerm on any non-200, so it went unnoticed. `loadBead` knows both of bd's
        // spellings of "no such bead" and is the same read the advocate door makes.
        const issue = await loadBead(bd, ws, id);
        if (!(issue.labels || []).some((l) => String(l).trim() === 'handoff')) {
          return json(res, 409, {
            error: `${id} is not a handoff — it has no \`handoff\` label, and this door briefs a session to continue one`,
          });
        }

        const already = advocateSession(liveSessions(cfg), id, { openedAt: openedRecently(`${ws.name}/${id}`) });
        if (already) {
          return json(res, 409, {
            error: already.opening
              ? `${id} already has a session opening — give the window a moment to come up`
              : `${id} already has a session open on it — “${already.name}”. One successor per handoff, never two.`,
            live: already.name || null,
            pid: already.pid,
          });
        }

        const { endorsed } = await endorse(bd, ws, issue);
        if (endorsed) console.log(`[beadcause] endorsed ${ws.name}/${id} — its handoff opened a session on it`);

        const { dir, mode, repo } = await openHandoffSession(cfg, ws, issue);
        rememberAdvocateOpened(`${ws.name}/${id}`);
        console.log(
          `[beadcause] opened a handoff session on ${whereLanded(ws.name, repo)}/${id} in ${dir} (permission mode: ${mode})`
        );
        return json(res, 200, { ok: true, dir, mode, repo, endorsed });
      }

      /**
       * The in-app terminal — see lib/terminal.js and lib/termsocket.js.
       *
       * These three do nothing but manage the *list*: open one, see what is open,
       * end one. Everything that happens inside a terminal happens on the
       * WebSocket, because it is bytes in both directions and nothing here could
       * usefully sit in the middle of that.
       *
       * Same two guards as `POST /api/session`, and for the same reason: this
       * endpoint starts a process, so the workspace has to be one we already serve
       * and a bead id has to look like one before it goes near a command line. The
       * title is read back from `bd` rather than taken from the body.
       */
      if (p === '/api/terminals' && req.method === 'GET') {
        return json(res, 200, {
          terminals: listTerminals(),
          workspaces: scopedWorkspaceNames(),
          enabled: terminalsEnabled(cfg),
        });
      }

      if (p === '/api/terminal' && req.method === 'POST') {
        if (!terminalsEnabled(cfg)) return json(res, 403, { error: 'terminal is disabled in config' });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);

        // Seeding on a bead is optional — an unseeded terminal is just a session in
        // the workspace's directory — but a seed that isn't there is a mistake worth
        // stopping on, because the brief is written around that bead's real title.
        let bead = null;
        const seedId = String(body.id || body.seed || '');
        if (seedId) {
          if (!BEAD_ID_RE.test(seedId)) return json(res, 400, { error: 'not a bead id' });
          const issue = await bd.show(ws, seedId).catch(() => null);
          if (!issue) return json(res, 404, { error: `no such bead: ${seedId}` });
          const q = toQuestion(ws.name, issue);
          // `labels` and not just the id and title: `openTerminal` reads the `repo:`
          // one off it to decide which checkout the pty comes up in.
          bead = { id: seedId, title: q.question || q.title || '', labels: issue.labels || [] };
        }

        const t = openTerminal(cfg, ws, {
          bead,
          prompt: terminalPrompt(ws.name, bead?.id || null, bead?.title || ''),
          cols: body.cols,
          rows: body.rows,
        });
        // A pty opening is news, and this is the event that makes it so.
        //
        // /admin draws a count of open terminals into the label of the button that
        // closes them — "the button says what it will do, with the real number in it"
        // is that page's rule — and it stopped asking on a ten-second timer when it
        // moved onto this log (bc-rk2o). Without an event here, a terminal opened on
        // the phone would leave the number on the Mac's screen wrong until something
        // unrelated happened to move. Two of these a day is nothing; a sweep every ten
        // seconds all day was not.
        bus.emit({ type: 'terminal', key: `terminal/${t.id}`, workspace: ws.name, id: t.id, action: 'opened' });
        return json(res, 200, { terminal: terminalSummary(t) });
      }

      if (p === '/api/terminal' && req.method === 'GET') {
        const t = getTerminal(url.searchParams.get('id'));
        if (!t) return json(res, 404, { error: 'no such terminal' });
        return json(res, 200, { terminal: terminalSummary(t) });
      }

      if (p === '/api/terminal/close' && req.method === 'POST') {
        const body = await readBody(req);
        const t = getTerminal(body.id);
        if (!t) return json(res, 404, { error: 'no such terminal' });
        closeTerminal(t.id);
        // The other half of the pair above: the count on /admin's button has to come
        // down as well as up.
        bus.emit({ type: 'terminal', key: `terminal/${t.id}`, workspace: t.workspace || null, id: t.id, action: 'closed' });
        return json(res, 200, { ok: true, terminal: terminalSummary(t) });
      }

      /**
       * File a new question. This is the share-target path: something on the
       * phone becomes a `human` bead you deal with later.
       */
      if (p === '/api/ask' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const title = String(body.title || '').trim();
        if (!title) return json(res, 400, { error: 'title is required' });
        const id = await bd.create(
          ws,
          {
            title,
            body: String(body.body || ''),
            priority: body.priority ?? 1,
          },
          // You filed this. `created_by` says so; `owner` is untouched, so it queues
          // exactly as it did — see `actorFor`.
          { actor: actorFor(req) }
        );
        if (!id) return json(res, 502, { error: 'bd created the issue but returned no id' });
        // You filed this yourself thirty seconds ago — don't push it back at you.
        hooks.suppressPush?.(`${ws.name}/${id}`);
        console.log(`[beadcause] filed ${ws.name}/${id} — ${title}`);
        bus.emit({ type: 'created', key: `${ws.name}/${id}`, workspace: ws.name, id });
        return json(res, 200, { ok: true, id, key: `${ws.name}/${id}` });
      }

      /**
       * File one bead from the form behind ＋ on Home's `All Beads` — bc-khoe.27.3.
       *
       * ＋ means *new*, and what new is belongs to the view (bc-khoe.27.1): a chat on
       * `Chats`, an epic on `My Epics`, and on the screen that lists every live bead in
       * the tracker, a bead. This is that screen's write.
       *
       * **It is not a second write path**, which is the one thing bc-khoe.27.3 asked
       * for. `createBead` above is the `bd create`, shared with the chat console's
       * accept button, so the two doors cannot come to disagree about labels, the
       * surface block or `created_by`. What is here is only what a *form* decides and a
       * draft does not.
       *
       * **The parent, which is the part that would otherwise file orphans.** A bead with
       * nothing decided above it is not workable — no advocate queues it and no session
       * opens on it (bc-rfnr.7) — and `underOwnedRoots` on the phone draws only what
       * descends from a root you own, so it is invisible as well as held. Typing a
       * parent is therefore not a nicety here, and leaving the field blank must not mean
       * "orphan": it means lib/homing.js, exactly as it does for every bead an agent
       * files, which lands it under the `unsorted` root when the workspace has one.
       * A workspace with no such root still files parentless — that is homing's
       * fail-open and this inherits it — but it says so in `warnings` rather than
       * reporting a clean success over a bead nothing will draw.
       *
       * A parent that was *named* and does not exist is a 400 rather than a warning: a
       * blank field is "you decide" and a typo is not, and filing under nothing because
       * a character was wrong is the failure this whole field exists to stop.
       *
       * `type` and `priority` go through lib/draft.js's own normalisers rather than a
       * second opinion about what bd will take, so `P1`, `high` and `1` all mean the
       * same thing here that they mean on a card in the console.
       */
      if (p === '/api/bead/create' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const title = String(body.title || '').trim();
        if (!title) return json(res, 400, { error: 'a title is required' });

        const warnings = [];
        const named = String(body.parent || '').trim();
        if (named && !(await bd.exists(ws, named))) {
          return json(res, 400, { error: `${named} is not a bead in ${ws.name}` });
        }
        // Named wins and is returned untouched; blank asks the tracker. `onWarn` is how
        // an export that could not be *read* is told apart from a graph that answered
        // "nowhere" — see lib/homing.js, bc-0i27.17.
        const home = await homeIn(bd, ws, { parent: named, onWarn: (w) => warnings.push(w) });
        // `gated` and not merely `!home.parent`: on a workspace with no open root at all
        // the gate fails open and the bead is perfectly workable, so warning about a
        // hold there would be a false claim printed at every filing. Same distinction,
        // same words, as `fileBeads` in lib/filing.js.
        if (!home.parent && home.gated) {
          warnings.push(
            'nothing to hang this under — filed with no parent, which means nothing will work it until ' +
              'you adopt it under an epic at any priority (bc-rfnr.7). Label an open one `unsorted` and ' +
              'the next one lands there.'
          );
        }

        let id;
        try {
          id = await createBead(
            ws,
            {
              title,
              type: BEAD_TYPES.includes(String(body.type || '')) ? String(body.type) : 'task',
              priority: normalizePriority(body.priority),
              description: String(body.description || ''),
              acceptance: String(body.acceptance || ''),
              // The form's Labels field is one text input, so what arrives is a string —
              // and `filterProposedLabels` takes a list. Handed straight through, a
              // string is iterated *by character*, and `ui` becomes the two labels `u`
              // and `i` with nothing saying so. Split the way lib/draft.js's `labelList`
              // splits the console's identical input, and for its reason: `bd create
              // --label 'a,b'` splits on the comma itself, so a label containing one
              // cannot reach the tracker whatever this does.
              labels: (Array.isArray(body.labels) ? body.labels : String(body.labels || '').split(','))
                .map((l) => String(l).trim())
                .filter(Boolean),
            },
            { actor: actorFor(req), parent: home.parent, onWarn: (w) => warnings.push(w) }
          );
        } catch (err) {
          // The form is still on screen with everything you typed in it, so the honest
          // answer is the refusal and not a redirect. bd's own first line, because "bd
          // refused this title" is a sentence you can act on and "500" is not.
          const why = String(err?.message || err).split('\n')[0];
          console.error(`[beadcause] could not file "${title}" in ${ws.name} — ${why}`);
          return json(res, 502, { error: why, warnings });
        }

        // You filed this yourself thirty seconds ago — don't push it back at you.
        hooks.suppressPush?.(`${ws.name}/${id}`);
        console.log(
          `[beadcause] filed ${ws.name}/${id}${home.parent ? ` under ${home.parent}` : ''} — ${title}`
        );
        // Every client is showing a list that just got longer — including this one,
        // which is what makes the new bead appear without a reload.
        bus.emit({ type: 'created', key: `${ws.name}/${id}`, workspace: ws.name, id });
        return json(res, 200, {
          ok: true,
          id,
          key: `${ws.name}/${id}`,
          workspace: ws.name,
          parent: home.parent || '',
          warnings,
        });
      }

      /**
       * Save — a pass made with edit mode on, filed as beads. See lib/edits.js.
       *
       * **The workspace is not the one on screen.** An edit typed into this screen is a
       * change to *this app*, whichever tracker's beads happen to be drawn on it, so it
       * goes to the workspace whose sessions open in this checkout — `ownWorkspace`, the
       * same answer lib/crash.js takes for the daemon's own crashes and for the same
       * reason. Filing a remark about `public/app.js` onto whatever workspace is first in
       * the config would put it on somebody else's board, and on this Mac that is a
       * different repo entirely. `edits.workspace` overrides it; a daemon that can name
       * neither refuses rather than guessing.
       *
       * **An empty pass is a refusal, not a quiet success.** "Nothing is filed if the
       * change list is empty" is the acceptance, and a 200 saying nothing happened reads
       * on a phone exactly like a save that worked.
       *
       * **A failure keeps the pass.** Whatever was filed comes back in `filed`, error or
       * not, and the phone drops exactly those entries and keeps the rest — the change
       * list is the only copy of what was said, and losing it is worse than filing twice.
       */
      if (p === '/api/edits' && req.method === 'POST') {
        const body = await readBody(req);
        const named = String(body.workspace || cfg.edits?.workspace || '').trim();
        const own = named || ownWorkspace(cfg);
        if (!own) {
          return json(res, 400, {
            error: 'this daemon cannot tell which workspace its own app belongs to — set edits.workspace',
          });
        }
        const ws = requireWorkspace(own);
        const pass = normalizePass(body);
        if (!pass.changes.length) {
          return json(res, 400, { error: 'there is nothing in this pass to file', dropped: pass.dropped });
        }
        const actor = actorFor(req);
        let out;
        try {
          out = await filePass(bd, ws, pass, { cfg, actor });
        } catch (err) {
          const detail = err.message.split('\n')[0];
          const partial = err.partial || null;
          console.error(`[beadcause] edit pass on ${ws.name} failed — ${detail}`);
          return json(res, 502, {
            error: detail,
            workspace: ws.name,
            root: partial?.root || null,
            session: partial?.session || null,
            filed: partial?.filed || [],
            dropped: pass.dropped,
          });
        }
        // You filed these yourself, from the phone that would be pushed at.
        for (const one of [out.session, ...out.filed]) hooks.suppressPush?.(`${ws.name}/${one.id}`);
        console.log(
          `[beadcause] edit pass ${ws.name}/${out.session.id} — ${out.filed.length} edit(s) under ${out.root.id}` +
            `${out.root.made ? ' (standing root created)' : ''}`
        );
        for (const one of [out.session, ...out.filed]) {
          bus.emit({ type: 'created', key: `${ws.name}/${one.id}`, workspace: ws.name, id: one.id });
        }
        return json(res, 200, {
          ok: true,
          workspace: ws.name,
          root: out.root,
          session: out.session,
          filed: out.filed,
          dropped: pass.dropped,
        });
      }

      /**
       * An error the app hit, filed as a P0 bead — or a comment on the one that
       * already covers it. See lib/errors.js for the fingerprint and the three
       * outcomes; this is the door, and it is deliberately thin.
       *
       * **`message` is the only required field**, and every other one is optional on
       * purpose. The caller of last resort is a browser's `window.onerror` for a
       * cross-origin script, which is handed the string "Script error." and nothing
       * else — no file, no line, no stack. That report is worth less than a full one
       * and it is still worth more than a red toast nobody saw, so it is accepted and
       * fingerprinted on the message alone.
       *
       * **The workspace defaults rather than being required.** The reporter is a page
       * that has no idea which repo it is looking at — an error in `public/app.js` is a
       * beadcause bug whichever workspace's beads happen to be on screen — so an
       * unnamed workspace goes to the one whose sessions open in this checkout:
       * `ownWorkspace`, the same answer lib/edits.js takes for an edit typed into this
       * screen and lib/crash.js for the daemon's own crashes, out of the same argument.
       * A caller that does know (bc-p38c.4's daemon-side handler, a script) may say.
       *
       * It went to `workspaces[0]` until bc-xl7n.130, on the assumption that the first
       * configured workspace is the daemon's own. Discovery sorts them by name, so the
       * assumption holds only for an install whose own repo wins the alphabet: on this
       * Mac `architecture` is first and every browser-reported error — a viewbar crash,
       * a failed `/api/poll` — was filed onto the Climative team's board, by beadcause,
       * under a personal identity. The daemon's own crashes were never affected, because
       * lib/crash.js was armed with `ownWorkspace` from the start; only this door was wrong.
       *
       * **A daemon that cannot name its own workspace still files**, onto `workspaces[0]`,
       * where `/api/edits` refuses instead. The difference is deliberate and it is the
       * "never a 500" rule one step further in: an edit pass that is refused is still on
       * the screen to retype, and an error report that is refused is gone. A bead on the
       * wrong board can be moved; one that was never filed is not news anybody gets.
       *
       * **Never a 500, whatever happens.** This endpoint is called *by* error handling,
       * and an error here would be reported to it: `window.onerror` fires, the post
       * fails, the failure is an error, and the page reports the reporting. So a
       * tracker that is down answers `{ok: false, reason}` with a 200 and the page
       * stops, rather than a 5xx that reads to the client as something worth retrying.
       *
       * **And nothing at all across a deploy that restarts this daemon** (bc-p38c.3).
       * A restart makes every open page fail every fetch at once, so the reconnect files
       * one P0 per screen per endpoint for the single fact that you pressed Ship — and
       * only the deploy journal can say why, which is `reportingQuiet` in lib/deploy.js.
       * Dropped, never queued: replaying them the moment the daemon is back is the same
       * storm a minute later. The page still shows the failure throughout, because the
       * toast is drawn before the report is built and does not depend on it.
       *
       * The gate is **here and not in `intake`** on purpose. bc-p38c.4 files the
       * daemon's own uncaught exceptions through the same module, and a daemon that
       * crashes during its own deploy is the single most valuable bead this app can
       * file: it is the new build failing to come up. That one must get through.
       */
      if (p === '/api/error' && req.method === 'POST') {
        const body = await readBody(req);
        // `ownWorkspace` and not `workspaces[0]`: the first configured workspace is
        // whatever sorts first alphabetically, which is somebody else's board.
        const own = body.workspace || ownWorkspace(cfg);
        const ws = own ? requireWorkspace(own) : cfg.workspaces[0];
        if (!ws) return json(res, 200, { ok: false, reason: 'this daemon has no workspace to file into' });
        const message = String(body.message || '').trim();
        if (!message) return json(res, 400, { error: 'message is required' });
        const quiet = reportingQuiet();
        if (quiet) {
          // Logged rather than silent: dropping a report is a decision, and the morning
          // after a bad deploy the question is which of the two this was.
          console.log(`[beadcause] error dropped — ${quiet.why} — ${message.slice(0, 80)}`);
          return json(res, 200, { ok: false, reason: quiet.why, quiet });
        }
        try {
          const out = await intakeError(bd, ws, { ...body, message }, { actor: actorFor(req), config: cfg });
          console.log(
            `[beadcause] error ${out.action} ${ws.name}/${out.id} — ${out.fingerprint.at || 'no source'} — ${message.slice(0, 80)}`
          );
          // Only a new bead is news. A comment on a bead already on somebody's screen
          // moves nothing on the inbox, and a page in a render loop would otherwise
          // wake every parked poller several times a second — which is also why this
          // asks what a new bead *is* rather than what it is not: 'coalesced' is the
          // loudest of the non-news outcomes and it is not 'commented' either.
          if (isNewBead(out.action)) {
            bus.emit({ type: 'created', key: `${ws.name}/${out.id}`, workspace: ws.name, id: out.id });
          }
          return json(res, 200, { ok: true, ...out, key: `${ws.name}/${out.id}`, label: ERROR_LABEL });
        } catch (err) {
          console.error(`[beadcause] could not file a reported error: ${err.message}`);
          return json(res, 200, { ok: false, reason: String(err.message || err).split('\n')[0] });
        }
      }

      /* ------------------------------------------------------------ console */

      /**
       * The chat session: a conversation about what to file, before anything is.
       *
       * Every other write path here acts on a bead that already exists. This one
       * decides what should — so it is deliberately split in two, and the agent is
       * on neither side of the write: it proposes, you edit, and
       * `/api/console/create` is the only thing that calls `bd create`.
       */
      if (p === '/api/consoles' && req.method === 'GET') {
        return json(res, 200, { consoles: scopedConsoles(), workspaces: scopedWorkspaceNames() });
      }

      /* ------------------------------------------------------------- agents */

      /**
       * Every agent, for the list on the agents screen.
       *
       * A workspace can be named, because the advocate resolves its foundation from
       * the repo it runs in and two repos can legitimately have differently-scoped
       * advocates. Unnamed falls back to the first configured workspace rather than
       * to the daemon's own directory: the daemon runs from wherever launchd started
       * it, which is not a repo anyone amended.
       */
      if (p === '/api/foundations' && req.method === 'GET') {
        const { ws, dir } = agentTarget(url.searchParams.get('workspace'));
        return json(res, 200, {
          agents: await agentList(dir),
          workspace: ws.name,
          workspaces: scopedWorkspaceNames(),
        });
      }

      /**
       * The map — every step of every flow, and whether it is code or an agent.
       *
       * Served from the same `lib/flowchart.js` the standalone page is rendered from,
       * with one difference that is the whole reason this endpoint exists rather than
       * the doc being linked: it hands in the **effective** foundations. The committed
       * page draws the baselines, because a file in `docs/` that rendered differently on
       * two machines would be worse than one that is slightly behind; a screen on the
       * phone is about *this* Mac, where an amendment you approved last week is part of
       * what an agent now is.
       *
       * The mermaid source is composed here rather than in the browser. It is a pure
       * function of the model and the client would derive the same string every repaint
       * — and `mermaidFor` lives beside the shapes it draws, where a sixth kind is one
       * edit rather than two.
       *
       * No workspace is required and none is read. This says nothing about any tracker,
       * which is why it is the one screen that still answers on a Mac whose `bd` is
       * broken — and often the screen you want most at that moment.
       */
      if (p === '/api/flowchart' && req.method === 'GET') {
        const { ws, dir } = agentTarget(url.searchParams.get('workspace'));
        // Tolerant on purpose, and it degrades to the baselines rather than to an error:
        // `all` already swallows a missing ref, so what reaches here is a checkout git
        // cannot resolve at all. The map is still true; only the amendments are missing.
        let foundations = null;
        try {
          foundations = Object.fromEntries((await allFoundations(dir)).map((f) => [f.id, f]));
        } catch (err) {
          console.error(`[beadcause] the map is drawing baselines — ${err.message.split('\n')[0]}`);
        }
        const map = flowchart({ foundations });
        for (const flow of map.flows) flow.mermaid = mermaidFor(flow.id);
        map.effective = Boolean(foundations);
        map.workspace = ws.name;
        return json(res, 200, map);
      }

      /**
       * One agent, for the detail screen behind a row on that list.
       *
       * `/api/foundation/agent`, and **not** `/api/foundation` — which is what this was,
       * and it never once answered. The bare path is the foundation *channel* six
       * hundred lines above; two handlers on one method and path is a first-one-wins,
       * so every open of this screen got `{requests, workspaces}`, set `state.agent`
       * to undefined and threw in `renderDetail()` on `a.title` — after `#list` had
       * already been hidden, so the agents list vanished and nothing replaced it. Four
       * tabs, the amend flow and the per-agent chat were all behind that.
       *
       * The name is the one the neighbours already use: `/api/foundation/amend`,
       * `/api/foundation/decline` and `/api/foundation/log` are all about an agent, so
       * `/api/foundation/agent` is where an agent belongs. The channel keeps the bare
       * path because it is the one of the two with callers outside this repo — a badge,
       * a watch face, `curl` — and the README's channel table names it.
       *
       * `test/routes.mjs` is what stops the collision coming back, for every route
       * rather than this one: it fails on any (method, path) registered twice, and it
       * asks the real `createApp` what these three paths return rather than asking a
       * fake that was written from the contract. `assertRoutes` at the foot of this
       * file is the same check at boot, so a duplicate that reaches a running daemon
       * — from a merge, a cherry-pick, a branch that never ran the suite — fails
       * loudly there too instead of blanking one screen in silence.
       */
      if (p === '/api/foundation/agent' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        if (!AGENT_KINDS.includes(id)) return json(res, 404, { error: `no such agent: ${id}` });
        const { ws, dir } = agentTarget(url.searchParams.get('workspace'));
        return json(res, 200, { agent: await agentDetail(dir, id, { workspace: ws.name }), workspace: ws.name });
      }

      /**
       * Edit a foundation.
       *
       * Adam editing by hand and an agent's request that he approved land in exactly
       * the same place, authored the same way, with the same justification field —
       * because the moment they diverge, `git log refs/beadcause/foundations` stops
       * being the whole story of what an agent was allowed to become.
       *
       * A protected field arriving here is a 400 with the reason, not a silent drop:
       * the screen renders those locked, so a request carrying one means the client
       * and the server disagree about what is editable, and that should be loud.
       */
      if (p === '/api/foundation/amend' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        if (!AGENT_KINDS.includes(id)) return json(res, 404, { error: `no such agent: ${id}` });
        const { ws, dir } = agentTarget(body.workspace);
        const set = body.set && typeof body.set === 'object' ? body.set : null;
        if (!set || !Object.keys(set).length) return json(res, 400, { error: 'nothing to change' });
        try {
          const f = await amend(dir, id, set, {
            bead: body.bead || null,
            justification: String(body.justification || '').trim(),
            by: ownerName(cfg),
          });
          bus.emit({ type: 'foundation', key: `agent/${id}`, id, workspace: ws.name });
          console.log(`[beadcause] foundation amended: ${id} — ${Object.keys(set).join(', ')}`);
          return json(res, 200, { ok: true, agent: f });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }

      /** Record a refusal, so the same request cannot come back every session. */
      if (p === '/api/foundation/decline' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        if (!AGENT_KINDS.includes(id)) return json(res, 404, { error: `no such agent: ${id}` });
        const { ws, dir } = agentTarget(body.workspace);
        try {
          const f = await decline(dir, id, {
            bead: body.bead || null,
            request: String(body.request || '').trim(),
            reason: String(body.reason || '').trim(),
            by: ownerName(cfg),
          });
          bus.emit({ type: 'foundation', key: `agent/${id}`, id, workspace: ws.name });
          return json(res, 200, { ok: true, agent: f });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }

      /** The streamed log for one run, by the key that run logs under. */
      if (p === '/api/foundation/log' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        if (!AGENT_KINDS.includes(id)) return json(res, 404, { error: `no such agent: ${id}` });
        const key = logKeyFor(id, {
          workspace: url.searchParams.get('ws') || url.searchParams.get('workspace') || '',
          bead: url.searchParams.get('bead') || '',
        });
        if (!key) return json(res, 200, { key: null, log: '', note: 'this agent keeps no log file' });
        return json(res, 200, { key, log: agentLog(key) });
      }

      if (p === '/api/console' && req.method === 'POST') {
        if (cfg.beadConsole === false) return json(res, 403, { error: 'beadConsole is disabled in config' });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);

        // Seeding is optional, and a seed that doesn't exist is a mistake worth
        // stopping on: the whole point of it is that the conversation starts with
        // that bead's real content in hand.
        let seed = null;
        const seedId = String(body.seed || body.id || '');
        if (seedId) {
          if (!BEAD_ID_RE.test(seedId)) return json(res, 400, { error: 'not a bead id' });
          // `bd show` throws on an id that isn't there rather than returning
          // nothing, and its message is a wrapped JSON error blob. What reaches the
          // phone should say which bead was not found and no more.
          let issue = null;
          try {
            issue = await bd.show(ws, seedId);
          } catch {
            /* reported below as a plain 404 */
          }
          if (!issue) return json(res, 404, { error: `no such bead: ${seedId}` });
          // Same as the terminal route: the labels ride along because one of them says
          // which of the workspace's checkouts this conversation belongs in.
          seed = { id: issue.id, title: issue.title || '', labels: issue.labels || [] };
        }

        // `agent` turns this into a chat with one of the other three rather than the
        // chat session. Same conversation machinery, different foundation, and no
        // proposal expected back — see `proposes` in lib/console.js.
        const agent = String(body.agent || 'console');
        if (!AGENT_KINDS.includes(agent)) return json(res, 400, { error: `no such agent: ${agent}` });

        const c = createConsole(cfg, ws, seed, { agent });
        // A seeded console has something to read before you can usefully type, so it
        // opens by itself. An empty one waits: you know what you want to say, and a
        // greeting nobody asked for costs a model round trip to say nothing.
        if (seed) await sendTurn(cfg, c, '', { flagDraft: (draft) => flagDraftDuplicates(ws, draft, c) });
        return json(res, 200, { ok: true, id: c.id, console: c });
      }

      if (p === '/api/console' && req.method === 'GET') {
        const c = getConsole(url.searchParams.get('id'));
        if (!c) return json(res, 404, { error: 'no such chat session' });
        return json(res, 200, c);
      }

      if (p === '/api/console/message' && req.method === 'POST') {
        if (cfg.beadConsole === false) return json(res, 403, { error: 'beadConsole is disabled in config' });
        const body = await readBody(req);
        const c = getConsole(body.id);
        if (!c) return json(res, 404, { error: 'no such chat session' });
        if (!String(body.text || '').trim()) return json(res, 400, { error: 'text is required' });
        const cws = requireWorkspace(c.workspace);
        await sendTurn(cfg, c, String(body.text), { flagDraft: (draft) => flagDraftDuplicates(cws, draft, c) });
        return json(res, 200, { ok: true, seq: c.seq });
      }

      /**
       * Follow a turn as it happens. Same shape as `/api/poll`, per console: park
       * until the sequence moves, then hand back the whole thing.
       *
       * The console is small — a conversation, not a list of every bead in seven
       * workspaces — so it is returned entire rather than as a diff. That is what
       * makes a phone that slept through half a turn correct on the first response
       * instead of having to reconcile a stream it missed.
       */
      if (p === '/api/console/poll' && req.method === 'GET') {
        const c = getConsole(url.searchParams.get('id'));
        if (!c) return json(res, 404, { error: 'no such chat session' });
        const since = Number(url.searchParams.get('since') || 0);
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 25), 0), 60);
        if (c.seq <= since && wait) await waitForConsole(c.id, since, wait * 1000);
        return json(res, 200, c);
      }

      /**
       * The cards as you edited them. Re-normalised, so the editor can't widen the
       * schema — which is also why the duplicate flag is re-derived here rather than
       * accepted from the phone: `normalizeDraft` drops it, and the server is the only
       * thing that ever says a card looks like an existing bead.
       *
       * Checked on an *edit* and not only on a turn, because a title you rewrite
       * yourself is a title nothing else has looked at, and because the draft you are
       * about to create may have been proposed an hour ago against a tracker that has
       * moved since. See `flagDraftDuplicates` for why that costs less than one `bd
       * list` per save.
       */
      if (p === '/api/console/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const c = getConsole(body.id);
        if (!c) return json(res, 404, { error: 'no such chat session' });
        const draft = body.draft ? normalizeDraft(body.draft) : null;
        setDraft(c, draft ? await flagDraftDuplicates(requireWorkspace(c.workspace), draft, c) : null);
        return json(res, 200, { ok: true, draft: c.draft, seq: c.seq });
      }

      /**
       * Create the beads. The only write in the whole console.
       *
       * The draft in the request body wins over the stored one, so what is created is
       * literally what was on screen when you pressed the button — no round trip in
       * between where a late-arriving turn could replace it.
       *
       * Order matters twice: parents and in-proposal dependencies must exist before
       * the bead that points at them, and `bd dep add` runs only after every id is
       * known. A create that fails part-way is reported with what *did* get made
       * rather than rolled back — beads has no transaction, and silently leaving
       * three real beads unmentioned is the worse failure. The same argument is why
       * one refused edge no longer ends the batch (bc-arj0.19, and lib/edges.js).
       */
      if (p === '/api/console/create' && req.method === 'POST') {
        const body = await readBody(req);
        const c = getConsole(body.id);
        if (!c) return json(res, 404, { error: 'no such chat session' });
        const ws = requireWorkspace(c.workspace);

        const draft = normalizeDraft(body.draft || c.draft);
        if (!draft?.beads?.length) return json(res, 400, { error: 'nothing to create' });

        // What the cards said about themselves when you were looking at them. Read off
        // the *stored* draft because `normalizeDraft` drops the flag — the phone may
        // not set one — and it is only ever logged: the console warns and does not
        // refuse (bc-x3e9), so this exists for the morning after, when the question is
        // whether a duplicate was filed knowingly or by nobody noticing.
        const flagged = new Map(
          (c.draft?.beads || []).filter((b) => b.duplicate?.id).map((b) => [b.ref, b.duplicate])
        );

        const order = topoOrder(draft.beads);
        const byRef = new Map(draft.beads.map((b) => [b.ref, b]));
        // Cycles are already broken in normalizeDraft; anything still unordered is
        // created last rather than dropped on the floor.
        const sequence = [...order.refs, ...order.cycles];

        const created = [];
        const warnings = [...(draft.warnings || [])];
        const ids = new Map();
        // An id named in the proposal but not created by it has to be real. Checked
        // once each, before anything is written, so a typo costs a warning rather
        // than a half-created proposal.
        const external = new Map();
        const resolve = async (ref) => {
          if (ids.has(ref)) return ids.get(ref);
          if (!external.has(ref)) external.set(ref, await bd.exists(ws, ref));
          return external.get(ref) ? ref : null;
        };

        // Set by a create that fails part-way, and read after the edges have been
        // applied rather than returned from the catch — see the comment on that pass.
        let createError = null;

        try {
          for (const ref of sequence) {
            const b = byRef.get(ref);
            if (!b) continue;
            const parent = b.parent ? await resolve(b.parent) : null;
            if (b.parent && !parent) warnings.push(`${b.ref}: parent ${b.parent} does not exist — created without it`);
            // The write itself is `createBead`, shared with the create form on Home's
            // `All Beads` (bc-khoe.27.3) — the labels guard, the surface block and the
            // `created_by` stamp are all one answer for both screens. What stays here is
            // what only a draft knows: the parent resolved against the other cards in
            // this pass, and the ref each created id belongs to. The agent argued these
            // into shape; pressing the button is what made them exist. The `bd dep add`
            // calls below are not attributed — wiring beads together is plumbing.
            const id = await createBead(ws, b, {
              actor: actorFor(req),
              parent: parent || '',
              onWarn: (w) => warnings.push(w),
            });
            ids.set(b.ref, id);
            created.push({ ref: b.ref, id, title: b.title });
            const dup = flagged.get(b.ref);
            if (dup) {
              console.log(
                `[beadcause] console ${c.id}: created ${id} over a flagged duplicate — ${dupeNote(dup)}, and you said so`
              );
            }
          }
        } catch (err) {
          createError = err.message.split('\n')[0];
          console.error(`[beadcause] console ${c.id}: create failed after ${created.length} — ${createError}`);
          warnings.push(`stopped after an error: ${createError}`);
        }

        /**
         * The edges, and they are outside that `try` on purpose — bc-arj0.19.
         *
         * They used to be the last thing inside it, so the first `bd dep add` bd refused
         * threw the whole request into the catch above and every edge after it in the
         * list was never attempted. The beads all existed and looked right; what was
         * missing was structure on the beads furthest from the error, and the error
         * named none of them. `applyEdges` never throws, records each refusal against
         * the edge that earned it, and reports the lot as commands you can paste back.
         *
         * Run even when a create failed, for the same reason: the beads that *were*
         * made are real, and the structure between them is no less true for a later
         * card having failed to become a bead.
         */
        const edges = await applyEdges(
          bd,
          ws,
          created.flatMap(({ ref, id }) =>
            (byRef.get(ref)?.dependsOn || []).map((dep) => ({ from: id, dep, ref }))
          ),
          { resolve }
        );
        warnings.push(...edges.warnings);
        if (edges.failed.length) {
          console.error(
            `[beadcause] console ${c.id}: ${edges.failed.length} of ${
              edges.failed.length + edges.applied.length
            } declared dependencies did not land — ${edges.failed
              .map((f) => `${f.from || f.dep}→${f.to || f.dep} (${f.reason || f.why})`)
              .join(', ')}`
          );
        }

        if (createError) {
          if (created.length) recordCreated(c, created, warnings);
          return json(res, 502, { error: createError, created, warnings });
        }

        recordCreated(c, created, warnings);
        // Accepting is the end of the conversation: the beads exist, and the console
        // that argued them into shape has done its job. Closed here rather than by a
        // second request so the phone gets one answer to act on — but ONLY on a
        // clean run. Warnings have to be read on the screen that produced them, and
        // dropping to the list would take them away before they were.
        const shouldClose = body.close !== false && !warnings.length;
        if (shouldClose) closeConsole(c, { reason: `Closed on accepting ${created.length} bead(s).` });
        console.log(
          `[beadcause] console ${c.id} created ${created.length} bead(s) in ${ws.name}: ${created.map((x) => x.id).join(', ')}`
        );
        // Other clients are showing a list that just got longer.
        for (const x of created) {
          bus.emit({ type: 'created', key: `${ws.name}/${x.id}`, workspace: ws.name, id: x.id });
          hooks.suppressPush?.(`${ws.name}/${x.id}`);
        }
        return json(res, 200, { ok: true, created, warnings, closed: shouldClose });
      }

      /**
       * Close a console by hand — the ✕ on a row in the list.
       *
       * Soft: the transcript stays, the id keeps working, and saying anything to it
       * reopens it. Refused mid-turn, because a reply arriving into something the
       * list calls finished is worse than a row you have to close twice.
       */
      if (p === '/api/console/close' && req.method === 'POST') {
        const body = await readBody(req);
        const c = getConsole(body.id);
        if (!c) return json(res, 404, { error: 'no such chat session' });
        closeConsole(c, { reason: 'Closed.' });
        console.log(`[beadcause] console ${c.id} closed`);
        return json(res, 200, { ok: true, consoles: scopedConsoles() });
      }

      /**
       * Every workspace at once: who is working on what, the counts, and enough to
       * get from here into that workspace's graph.
       *
       * Three `bd` calls per workspace, run in parallel across all of them — about a
       * second in total for six. Deliberately not folded into /api/questions: that
       * one is polled every 30 seconds by every client, and this is opened when you
       * want it.
       */
      if (p === '/api/work' && req.method === 'GET') {
        // Where in the event log this answer is true, read *before* the sweep rather
        // than after it. An event that lands while `bd` is being asked is one this
        // payload does not contain, and a sequence taken afterwards would claim it
        // does — so a holder of this payload would park past the very event that
        // invalidated it. Reading early means the holder refreshes once too often
        // instead, which is the harmless direction to be wrong in.
        const at = bus.seq;
        // Read off the filesystem before the sweep, always fresh — see lib/work.js for
        // why `sessions` is not on lib/cache.js with the `bd` calls it is matched
        // against below, which as of bc-1kwl.7 can be up to ten seconds old.
        const sessions = liveSessions(cfg);
        const rows = await collectWork(bd, scopedWorkspaces(), readActivity(), sessions);
        // One loopback call to the router that is proxying this very request, in
        // parallel with nothing because it costs a millisecond and the bd sweep above
        // has already been waited on. Null under `start:bare`, where there is no router.
        const router = await routerHealth(cfg);
        return json(res, 200, {
          workspaces: rows,
          // Sessions in a directory that maps to no configured workspace. Only
          // reachable without `projectRoot` set, but they are still sessions, and a
          // view called "current sessions" must not silently drop them.
          elsewhere: sessions.filter((x) => !x.workspace),
          // In-memory, so it costs nothing to send: what each repo's advocate is
          // doing, what it is about to pick up, and why it is holding off.
          advocates: scopedAdvocates(),
          // And the numbers that belong to no repo — the cap across every advocate,
          // the range its stepper may offer, and how much of it is in use right now.
          // Sent separately rather than read off the first advocate card, because the
          // console filters those by space and this cap does not.
          globals: advocates.globals(),
          // Every configured workspace and whether its advocate can be switched on or
          // off from here. `advocates` above only carries the repos that *have* one, so
          // a repo with none is drawn from `workspaces` — and until this existed the
          // page had no way to tell "nobody has switched this on" from the two states
          // where the switch would write a setting and change nothing. See `roster`.
          roster: advocates.roster(),
          // Which daemon you are looking at. Every advocate card says `observing`
          // on its own, but an instance with no advocates configured would look
          // exactly like the live one — and believing you are in observer mode
          // when you are not is the whole failure this mode exists to prevent.
          observing: OBSERVING,
          // What launchd is running, every time — see the note above serviceHealth.
          // One small file read beside a `bd` sweep, so it is recomputed rather than
          // cached: a health line that can be twenty seconds out of date is a health
          // line that will be wrong for the one refresh you were watching.
          service: serviceHealth(),
          // And whether the program launchd is running is actually serving anything —
          // see routerHealth, including what this can and cannot see. The states worth
          // a line here are the degraded ones: a build that died at startup, or one
          // that was too slow and is being retried, both of which leave the phone on
          // yesterday's code with nothing anywhere saying so.
          router,
          // Where in the event log this payload was true — the same field
          // `/api/questions` carries, added for the same reason and captured above.
          // It is what lets a *held* copy of this payload be maintained rather than
          // merely kept: the inbox, which is parked on the log all day, folds each
          // wake's advocate snapshot into the copy it is holding for the advocates
          // tab and only re-asks here when an event says `bd` would now answer
          // differently. Without a sequence the copy could only age out, and a
          // fifteen-minute-old entry is a tab that is cold again by the time you tap
          // it. Additive: a client that ignores it behaves exactly as it did.
          seq: at,
        });
      }

      /**
       * The agents you can put a comment to — see lib/agents.js.
       *
       * The four built-ins are always here; the rest are yours. `tools` is never
       * sent and never accepted: an agent created from a phone gets the same
       * read-only reach as every other one, and widening that is a config-file act.
       */
      if (p === '/api/agents' && req.method === 'GET') {
        return json(res, 200, { agents: rosterNow(), default: cfg.defaultAgent || 'answerer' });
      }

      /**
       * Arm an agent's configured tools override for one reply.
       *
       * Three gates, and each exists for a different failure:
       *
       * - **There must be an override to arm.** The string lives in the config file
       *   and nothing here writes it. A phone can decide *whether* an agent uses its
       *   extra reach; deciding *what that reach is* stays a deliberate act at a
       *   keyboard, which is the whole line drawn when agents became creatable.
       * - **Not while it is answering.** Changing what a running agent may do is
       *   either meaningless (the process already has its allowlist) or an attempt to
       *   widen it mid-flight, and both deserve a refusal that names the bead.
       * - **Once, with the warning read.** The first arming of each agent must carry
       *   `acknowledge`, and the dialog it comes from is generated here so every
       *   client says the same thing about the same tools.
       */
      if (p === '/api/agent-arm' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        const agent = roster1(id);
        if (!agent) return json(res, 404, { error: `no agent called ${id || '(none given)'}` });

        if (body.disarm) {
          armedTools.delete(agent.id);
          console.log(`[beadcause] ${agent.name}: extended tools disarmed`);
          return json(res, 200, { ok: true, armed: false, agents: rosterNow() });
        }

        if (!agent.tools) {
          return json(res, 400, {
            error: `no tools override is configured for ${agent.name} — add a "tools" string to its entry in agents[] in ${CONFIG_PATH}`,
          });
        }

        const busyOn = agentBusyOn(agent.id);
        if (busyOn) {
          return json(res, 409, {
            error: `${agent.name} is answering ${busyOn} — you can't change what it may do while it is doing it`,
          });
        }

        if (!acknowledged(cfg, agent.id) && !body.acknowledge) {
          return json(res, 428, { needsAcknowledgement: true, disclaimer: disclaimerFor(agent) });
        }

        if (acknowledge(cfg, agent.id)) saveConfig(cfg);
        armedTools.add(agent.id);
        console.log(`[beadcause] ${agent.name}: EXTENDED TOOLS armed for its next reply — ${agent.tools}`);
        return json(res, 200, { ok: true, armed: true, agents: rosterNow() });
      }

      if (p === '/api/agents' && req.method === 'POST') {
        // Deliberately no `tools` here, and there never will be: see agent-arm above.
        const body = await readBody(req);
        const agent = addAgent(cfg, { name: body.name, description: body.description, emoji: body.emoji });
        saveConfig(cfg);
        console.log(`[beadcause] new agent: ${agent.name} (${agent.id})`);
        return json(res, 200, { ok: true, agent, agents: publicRoster(cfg) });
      }

      if (p === '/api/agents' && req.method === 'DELETE') {
        const id = removeAgent(cfg, String(url.searchParams.get('id') || ''));
        saveConfig(cfg);
        console.log(`[beadcause] removed agent ${id}`);
        return json(res, 200, { ok: true, agents: publicRoster(cfg) });
      }

      /*
       * `GET /api/advocates` was here — "every advocate's state on its own, for anything
       * that isn't the work page". Nothing ever was: no page, no script, no test and
       * nothing in the Android shell asked for it, and the payload it returned
       * (`advocates.snapshot()`) is a field on `/api/work` and on `/api/poll` already.
       * Its only trace outside this file was a row in the README's own API table, which
       * is how it stayed convincing.
       *
       * Deleted rather than left: a route with no callers is a contract nobody is
       * keeping, and the next change to the advocate snapshot has one fewer shape to be
       * careful about. If a badge or a watch face ever wants the advocates on their own,
       * `/api/work` answers it in one field and this is three lines to bring back.
       */

      /**
       * Pause, resume, reclaim the slots of, or forgive one advocate.
       *
       * `reclaim` is the interesting one, and the only action here that talks to
       * anything: it says "are you still working?" into each open session's own iTerm
       * window and frees only the slots whose window has gone. It can therefore take
       * an Apple event per worker, which is why this awaits — the snapshot in the
       * reply has to be the one *after* the asking, or the page repaints the state the
       * button was pressed in. `release` is the same action under its old name.
       *
       * `limit` is the one action that carries a number, and the only one that writes
       * to config.json — see `saveWorkerLimit`. The reply is the same snapshot every
       * other action returns, so the card repaints the limit it now has rather than
       * the one it asked for; the two differ whenever the clamp bit.
       *
       * `globalLimit` is the same press one level up, and the reason the workspace
       * check below cannot come first: `advocates.globalMaxWorkers` is a total across
       * every advocate, so it belongs to no repo and a request for it carries no
       * workspace to be found. Refused outright while observing, for the reason the
       * space settings are: an observer loads the *real* daemon's config file, so a
       * press here would change what the other process does at its next restart and
       * nothing at all about what it is doing now.
       *
       * `enable` and `disable` are the other two that cannot come after the workspace
       * check, and for the opposite reason to `globalLimit`: they carry a workspace and
       * the whole point of `enable` is that it names one with *no* advocate, which is
       * precisely what `has` refuses. Both write `advocates.workspaces` and reconcile
       * the live set, so the reply carries the roster as well — the switch on the card
       * is drawn from it, and a page that repainted the snapshot alone would show the
       * advocate appear while the switch beside it still said Off. Observing is refused
       * for the reason every other write here is: an observer holds the real daemon's
       * config file, so this would change what the *other* process does at its next
       * restart and nothing at all about what it is doing now.
       */
      if (p === '/api/advocate' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (action === 'globalLimit') {
          if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
          advocates.setGlobalLimit(body.value);
          return json(res, 200, { ok: true, advocates: scopedAdvocates(), globals: advocates.globals() });
        }
        if (action === 'enable' || action === 'disable') {
          if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
          advocates[action](String(body.workspace || ''));
          return json(res, 200, {
            ok: true,
            advocates: advocates.snapshot(),
            globals: advocates.globals(),
            roster: advocates.roster(),
          });
        }
        // Pausing an epic writes a label to the shared tracker and types into windows this
        // instance did not open. `pause` and `resume` above it are a local decision about a
        // loop that is not running here anyway; these two act, which is the line an
        // observer instance does not cross — the same one `POST /api/bead/advocate` and
        // the tick's own `if (OBSERVING) return` draw.
        if ((action === 'epicPause' || action === 'epicResume') && OBSERVING) {
          return json(res, 403, { error: OBSERVING_NOTE });
        }
        const name = String(body.workspace || '');
        if (!advocates.has(name)) return json(res, 404, { error: `no advocate for ${name || '(none given)'}` });
        const outcome = await advocates.control(name, action, body.value);
        // `control` returns nothing for the actions that only change a number or a flag,
        // and a report for `epicPause` — how many windows were reached and how many were
        // not. Passed through rather than logged only: "paused, and I could not reach two
        // of the windows" is the one thing about a pause that the next repaint cannot
        // show, because an unreachable window looks exactly like one that was told.
        return json(res, 200, {
          ok: true,
          ...(outcome && typeof outcome === 'object' ? { outcome } : {}),
          advocates: scopedAdvocates(),
          globals: advocates.globals(),
        });
      }

      /**
       * The admin screen's whole picture: every scope, and what pausing it costs.
       *
       * Read-only and cheap — no `bd` call, no process spawn — because /admin polls
       * it and the counts on the buttons have to be current when you press one.
       */
      if (p === '/api/admin' && req.method === 'GET') {
        return json(res, 200, admin.status());
      }

      /**
       * What every route on this server has actually cost, warm and cold, with the
       * subprocess share broken out.
       *
       * The one route whose answer is about the server rather than about the work, and
       * the reason it is a route at all rather than a log grep: the figures that matter
       * are the ones gathered from the *phone* in ordinary use, and the phone is the one
       * client that cannot read a response header or a launchd log. `npm run timings`
       * prints this as a table; `/api/timings` is what it reads.
       *
       * Costs nothing to serve — two fixed-size buckets per route, in memory — so it is
       * safe to poll and safe to leave on. It is not persisted and not meant to be: the
       * numbers are about the build that is running, and a deploy restarts the daemon.
       */
      if (p === '/api/timings' && req.method === 'GET') {
        return json(res, 200, timing.snapshot());
      }

      /**
       * Pause or resume everything, or one space, or one half of it.
       *
       * `{action, what, scope, mode}` — see lib/admin.js for what each does. The
       * two that matter: `what` is `all` | `advocates` | `terminals`, because
       * stopping the windows on the Mac and closing the ptys on the phone are
       * separate wants; and `mode` is `drain` (default — no new launches, running
       * workers finish untouched) or `kill`, which SIGTERMs them mid-work.
       *
       * Nothing here is ever run at boot. That is the constraint the whole feature
       * exists under: a `launchctl kickstart -k` must behave exactly as it does now.
       */
      if (p === '/api/admin' && req.method === 'POST') {
        // An observer loads the same `advocates.json`, so its snapshot carries the
        // real daemon's worker pids — `mode: "kill"` from here would reach across
        // and end them. Reading the state is fine; pressing the button is not.
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const out = admin.control({
          action: String(body.action || ''),
          what: String(body.what || 'all'),
          scope: String(body.scope ?? '*'),
          mode: String(body.mode || 'drain'),
        });
        return json(res, 200, { ok: true, ...out });
      }

      /**
       * Every browser that is signed in, and which of them is asking.
       *
       * Answered for a token caller too — `curl` and the Android app both reach this,
       * and both already hold the credential that could rotate the key underneath it,
       * so there is nothing here they could not already do. What they get back is
       * `current: null`, because a caller with no cookie is not one of these rows.
       *
       * `google: false` is the whole answer on an install with no sign-in configured:
       * there are no sessions to list, and the screen draws nothing rather than an
       * empty list that reads as "you are signed out everywhere".
       */
      if (p === '/api/devices' && req.method === 'GET') {
        const on = Boolean(authNow());
        const current = sessionOf(req)?.sid || null;
        return json(res, 200, { google: on, current, devices: on ? devices.list({ current }) : [] });
      }

      /**
       * End one signed-in browser, and no other. `{action: 'revoke', id}`.
       *
       * The row is deleted, so the cookie that names it verifies and authorises
       * nothing — see lib/devices.js. It takes effect on that device's next request,
       * on either backend, because the list is a file both of them re-read rather than
       * a map in the process that happened to serve this one.
       *
       * **Not refused for an observer**, unlike `/api/admin` and `/api/tls`. Those
       * reach across into the real daemon's processes and its config; this writes the
       * device list, which a spare-port instance genuinely shares — the session it is
       * revoking is the same session, and refusing here would leave a live button on a
       * screen that could not honestly draw one.
       *
       * `self` says the caller has just revoked the browser it is holding, which is
       * exactly signing out and is the one press that needs a different sentence
       * afterwards. The cookie is cleared in that case too, so the browser is not left
       * holding a value the next request will refuse.
       */
      if (p === '/api/devices' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || 'revoke');
        if (action !== 'revoke') return json(res, 400, { error: `unknown action: ${action}` });
        const id = String(body.id || '');
        if (!id) return json(res, 400, { error: 'no device id' });
        const here = sessionOf(req);
        const self = Boolean(here?.sid && here.sid === id);
        const revoked = devices.revoke(id);
        if (revoked) console.log(`[auth] revoked a signed-in device${self ? ' — this one' : ''}`);
        const current = self ? null : here?.sid || null;
        const reply = JSON.stringify({ ok: true, revoked, self, current, devices: devices.list({ current }) });
        // Written by hand rather than through `json` because of the one header: the
        // browser that just revoked itself must not be left holding a cookie the next
        // request will turn away.
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(self ? { 'set-cookie': [clearCookie(SESSION_COOKIE, { secure: secureCookies(authNow()) })] } : {}),
        });
        return res.end(reply);
      }

      /**
       * Which trackers this Mac serves, and which have been set aside.
       *
       * The picker is a `<select>`, which cannot carry a button per row, and a repo you
       * have finished with is otherwise in it forever: the only way out was
       * `workspaceDirs.<name>: null` in ~/.config/beadcause/config.json, on a machine you
       * have to be sitting at. So the list lives here, on the page that is about what this
       * Mac is doing rather than about beads — see the header of public/admin.js.
       *
       * `space` is what the picker would file each one under, so a row says where it is
       * about to disappear from. `retired` is the other half of the same list and is what
       * makes the act reversible on screen: a name is on it because somebody pressed
       * Retire, and `restorable` says whether bringing it back would actually find
       * anything — a tracker whose directory has since gone must not offer a button that
       * silently does nothing.
       */
      if (p === '/api/workspaces' && req.method === 'GET') {
        const saved = loadState();
        const account = activeAccount(cfg, saved);
        const retiredNames = Object.entries(cfg.workspaceDirs || {})
          .filter(([, dir]) => dir === null)
          .map(([name]) => name);
        // What discovery would answer with the exclusions lifted — asked of a copy, so the
        // live config is never the thing being experimented on. This is the only honest way
        // to say whether a bring-back would find a tracker: the `null` that retired it
        // replaced the directory, so the name alone no longer knows where it lived.
        const withoutExclusions = Object.fromEntries(
          Object.entries(cfg.workspaceDirs || {}).filter(([, dir]) => dir !== null)
        );
        const findable = new Set(discoverWorkspaces({ ...cfg, workspaceDirs: withoutExclusions }).map((w) => w.name));
        return json(res, 200, {
          workspaces: [...workspaces.values()].map((w) => ({
            name: w.name,
            dir: w.dir,
            space: spaceFor(cfg, w.name)?.name || null,
            // Whether the active account can see it at all. A row outside it is still
            // listed — this page is the machine's and deliberately has no picker — but a
            // Retire button on a repo the screens are not showing wants saying out loud.
            inAccount: inAccount(account, w.name),
          })),
          retired: retiredNames.map((name) => ({
            name,
            space: spaceFor(cfg, name)?.name || null,
            restorable: findable.has(name),
          })),
          // What the Add dialog prefills its "clone to" field with, and where a tracker it
          // makes would go. Both are config, both are on this payload rather than on a
          // route of their own, and neither is a place the dialog is allowed to assume:
          // an install with a `projectRoot` clones somewhere quite different from one
          // without, and a phone cannot see either.
          cloneRoot: tilde(defaultCloneRoot(cfg)),
          trackerRoot: tilde(defaultTrackerRoot(cfg)),
          observing: OBSERVING,
        });
      }

      /**
       * Set a tracker aside, or bring one back. `{action: 'retire'|'restore', workspace}`.
       *
       * Retiring writes `workspaceDirs.<name>: null` — the one thing lib/config.js already
       * documents as "takes one out and keeps it out" — and nothing else. In particular the
       * name is **left in its space**, and that is the whole reason a bring-back is one
       * key: the repo returns to the space it was always in, with every per-workspace
       * setting it had. Dropping it from `spaces[].workspaces` would make Restore guess,
       * and a wrong guess puts the tracker in "Other" without saying so. `spaceDetail`
       * knows the difference and reports a retired name as retired rather than as drift.
       *
       * The beads are untouched. This is a line in a config file about what gets *read* —
       * the tracker stays on disk exactly as it is, which is what makes the button safe
       * enough to put on a screen, and what its confirm sentence says.
       *
       * Both halves take effect without a restart, which needs two writes rather than one:
       * `cfg.workspaces` is what every sweep re-reads per tick, and the `workspaces` Map is
       * what the routes that act on one named repo resolve through. A retire that wrote
       * only the file would keep sweeping the tracker until somebody restarted the daemon,
       * while the screen said it had stopped.
       *
       * Refused on an observer, like `/api/space` and `/api/admin`: `cfg` here is the
       * acting daemon's config file, and a spare-port instance writing it would be one
       * process changing what another is serving.
       */
      if (p === '/api/workspaces' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const action = String(body.action || '');
        const name = String(body.workspace || '');

        /**
         * `add` — a tracker this Mac has never served, from a path or a GitHub URL.
         *
         * The other half of Retire, and the half that could not be done from a phone at
         * all: `workspaceDirs` by hand, in an editor, on the Mac. See lib/newspace.js for
         * the vocabulary this speaks in — **bead-space** for what the config calls a
         * workspace, **bead-repo** for a checkout attached to one — and for every refusal,
         * all of which are decided over there so that the suite can assert them without a
         * server.
         *
         * ## It answers in two rounds, and only when it has to
         *
         * A directory either has a `.beads` or it does not, and that is not a question to
         * ask a person: they mostly do not know, and the directory always does. So the
         * first round resolves or clones, looks, and finishes on the spot in the common
         * case. Only when there is no tracker does it come back with `needs: 'tracker'`
         * and the two answers that could not be guessed — a graph of its own, or beads
         * filed into a bead-space that already exists — plus the list to choose from.
         *
         * The second round arrives as a **path**, always: the client is handed the
         * directory the clone landed in and sends that back. A round two that re-sent the
         * URL would have to decide whether the directory it finds is the clone it made a
         * moment ago or somebody else's checkout of the same name, and there is no answer
         * to that which is right every time.
         *
         * ## What is written, and where it takes effect
         *
         * Both places, in the order retire/restore below already establishes: `cfg` is
         * what this tick serves and `config.json` is what survives a restart, and one
         * without the other is a bead-space that appears in an hour or vanishes at the
         * next boot. The live `workspaces` Map is the third — it is what every route that
         * names one repo resolves through, so a new tracker that was only in `cfg` would
         * be swept but not reachable.
         *
         * The clone is deliberately **not** rolled back when the tracker question is
         * refused or abandoned. Something was fetched from a network onto a disk; deleting
         * a directory tree to tidy up a dialog is not a thing a daemon should do behind a
         * cancel, and the reply says where it is instead.
         *
         * Account scoping is reported and never changed. If the account you are in has an
         * explicit list, a name it does not carry is invisible on every screen — so the
         * reply says that in a sentence rather than quietly widening what an account owns,
         * which is a decision that belongs on the accounts screen.
         */
        if (action === 'add') {
          const src = readSource(body, cfg);
          if (src.problem) return json(res, 400, { error: src.problem });

          const clash = nameProblem(cfg, [...workspaces.keys()], src.name);
          if (clash) return json(res, 400, { error: clash });

          if (src.kind === 'git') {
            const cloned = await cloneRepo({ url: src.url, dir: src.dir });
            if (!cloned.ok) return json(res, 400, { error: cloned.error });
            console.log(`[beadcause] cloned ${src.url} into ${src.dir} — from the app`);
          }

          const at = inspectDir(src.dir);
          if (!at.exists) return json(res, 404, { error: `${src.dir} is not a directory on this Mac` });

          /* Register a directory that is already a tracker, and answer. Shared by the
             round-one hit and by round two's "make me one", because from the config's
             point of view those differ only in who made the `.beads`. */
          const serve = (dir, { checkout = null, extra = [] } = {}) => {
            const entry = { name: src.name, dir: path.join(dir, '.beads') };
            const pinned = pinBeadSpace(cfg, {
              name: src.name,
              dir,
              discoverable: isDiscoverable(cfg, entry),
            });
            const changed = [...pinned.changed, ...extra];
            // Only when the checkout is somewhere else. A tracker that *is* its own
            // directory needs no pin, and one under `projectRoot` is found by the rule.
            if (checkout && path.resolve(checkout) !== path.resolve(dir)) {
              changed.push(...pinSessionDir(cfg, { name: src.name, dir: checkout }).changed);
            }
            workspaces.set(src.name, pinned.entry);
            saveConfig(cfg);
            console.log(`[beadcause] added bead-space ${src.name} (${dir}) — from the app`);
            const account = activeAccount(cfg, loadState());
            return json(res, 200, {
              ok: true,
              action,
              added: { name: src.name, dir, beads: pinned.entry.dir },
              changed,
              // Said, never fixed — see the block above.
              unseen: inAccount(account, src.name)
                ? null
                : `${src.name} is not in the account you are in, so it will not appear until you add it on the accounts screen`,
            });
          };

          if (at.beads) return serve(src.dir);

          /* No tracker. Round one stops here and asks; round two says which of the two. */
          const tracker = body.tracker && typeof body.tracker === 'object' ? body.tracker : null;
          if (!tracker) {
            const served = [...workspaces.values()];
            return json(res, 200, {
              ok: false,
              needs: 'tracker',
              name: src.name,
              dir: src.dir,
              cloned: src.kind === 'git',
              // A team clone that has not been bootstrapped. Offering `bd init` here is
              // the one irreversible mistake in this route — see lib/newspace.js — so the
              // choice is withheld rather than drawn and then refused.
              carriesData: at.data,
              prefix: suggestPrefix(src.name, served),
              beadSpaces: served.map((w) => w.name),
            });
          }

          const mode = String(tracker.mode || '');
          if (mode === 'attach') {
            const host = String(tracker.workspace || '');
            if (!workspaces.has(host)) {
              return json(res, 404, { error: `${host || '(none given)'} is not a bead-space this Mac serves` });
            }
            const attached = attachBeadRepo(cfg, { workspace: host, dir: src.dir });
            if (attached.already) {
              return json(res, 400, { error: `${src.dir} is already a bead-repo of ${host}` });
            }
            saveConfig(cfg);
            console.log(`[beadcause] attached ${src.dir} to bead-space ${host} — from the app`);
            const { unresolved } = repoList(cfg, host);
            const tokenless = unresolved.find((u) => u.dir && path.resolve(u.dir) === path.resolve(src.dir));
            return json(res, 200, {
              ok: true,
              action,
              attached: { name: src.name, dir: src.dir, workspace: host },
              changed: attached.changed,
              // Attached and useless is a real outcome and it must not read as success:
              // without a service token nothing can say a bead is about this repo. The
              // list is Adam's to write, and so is the token — lib/repos.js reads it from
              // the checkout on purpose and this does not write one.
              warning: tokenless
                ? `${src.name} ${tokenless.problem} — it is on ${host}'s list, but no bead can name it until its config/config.yaml declares a serviceToken`
                : null,
            });
          }

          if (mode !== 'new') return json(res, 400, { error: `unknown tracker choice: ${mode || '(none given)'}` });

          if (carriesBeadsData(src.dir)) {
            return json(res, 400, {
              error: `${src.name} already carries beads history on refs/dolt/data — run npm run onboard on the Mac to bootstrap it, rather than making a second tracker it could never merge with`,
            });
          }
          const prefix = String(tracker.prefix || '').trim().toLowerCase();
          if (!PREFIX_OK.test(prefix)) {
            return json(res, 400, { error: `"${prefix}" is not a usable id prefix — two to four letters or digits, like bc or sp` });
          }
          const used = prefixesInUse([...workspaces.values()]).get(prefix);
          if (used) return json(res, 400, { error: `${used} already mints ${prefix}- ids — two graphs sharing a prefix makes every id ambiguous` });

          const root = defaultTrackerRoot(cfg);
          const made = await initTracker({ root, name: src.name, prefix, bin: cfg.bdBin, actor: cfg.me || '' });
          if (!made.ok) return json(res, 400, { error: made.error });
          console.log(`[beadcause] made tracker ${made.beads} with prefix ${prefix} — from the app`);
          return serve(made.dir, { checkout: src.dir, extra: [`bd init --prefix ${prefix} in ${made.dir}`] });
        }

        if (action !== 'retire' && action !== 'restore') {
          return json(res, 400, { error: `unknown action: ${action || '(none given)'}` });
        }
        if (!name) return json(res, 400, { error: 'no workspace named' });

        const dirs = { ...(cfg.workspaceDirs || {}) };
        if (action === 'retire') {
          if (!workspaces.has(name)) return json(res, 404, { error: `${name} is not a tracker this Mac serves` });
          // The last one is refused. Every screen in the app is a list of beads from
          // somewhere, and an install serving nothing is a working daemon whose only way
          // back is the config file this button exists to avoid.
          if (workspaces.size < 2) {
            return json(res, 400, { error: `${name} is the only tracker this Mac serves — retiring it would leave nothing` });
          }
          dirs[name] = null;
          cfg.workspaceDirs = dirs;
          cfg.workspaces = (cfg.workspaces || []).filter((w) => w.name !== name);
          workspaces.delete(name);
        } else {
          if (dirs[name] !== null) return json(res, 404, { error: `${name} is not retired` });
          delete dirs[name];
          cfg.workspaceDirs = dirs;
          // Discovery is asked rather than a remembered directory replayed: the tracker may
          // have moved between the two presses, and the roots are what know where it is
          // now. A name it cannot find is a refusal and the retirement stands — the
          // alternative is an entry in `workspaces` pointing at nothing, which every sweep
          // would then fail on once per tick.
          const found = discoverWorkspaces(cfg).find((w) => w.name === name);
          if (!found) {
            cfg.workspaceDirs = { ...dirs, [name]: null };
            return json(res, 404, {
              error: `no tracker called ${name} could be found — nothing under the configured roots has that name`,
            });
          }
          cfg.workspaces = [...(cfg.workspaces || []), found].sort((a, b) => a.name.localeCompare(b.name));
          workspaces.set(name, found);
        }
        saveConfig(cfg);
        console.log(`[beadcause] ${action === 'retire' ? 'retired' : 'restored'} workspace ${name} — from the app`);

        /* The picker's cached rows still name it. `spacesPending` is the last sweep's
           `summarise()` output and is only rebuilt by a sweep, so a retire would sit in the
           synthetic "Other" group until the next one — and a restore would be missing from
           it for just as long. Rebuilding it here with no questions would zero every row,
           so the stray group is corrected in place instead: that group is the one thing in
           the payload that names workspaces rather than a space.

           The repo rows of a real space need no correction — public/spacebar.js filters
           those against the served list it is handed beside them. */
        spacesPending = spacesPending
          .map((row) =>
            row.name === 'Other' ? { ...row, workspaces: (row.workspaces || []).filter((w) => workspaces.has(w)) } : row
          )
          .filter((row) => row.name !== 'Other' || (row.workspaces || []).length);
        return json(res, 200, { ok: true, action, workspace: name });
      }

      /**
       * HTTPS: what it is doing, and what turning it on or off would cost.
       *
       * Read-only, off the disk, and cheap enough to poll — two file reads, a
       * certificate parse and a memoised MagicDNS name. It deliberately never asks
       * `tailscale cert` for anything: fetching a certificate is a Let's Encrypt round
       * trip, and a screen that did it on a timer would spend two minutes of the
       * daemon's life every ten seconds.
       *
       * `?pairing=1` adds the link and the QR — ten kilobytes of SVG, asked for only
       * when something is going to draw it.
       *
       * The one fact this process does not hold is what is on the *socket*: behind the
       * router it binds loopback and speaks plain HTTP by design. So `liveTls()` asks
       * the router, falls back to what this process's own `listen()` bound under
       * `npm run start:bare`, and answers `null` when neither can say — which the
       * screen draws as silence rather than as agreement.
       */
      if (p === '/api/tls' && req.method === 'GET') {
        return json(res, 200, {
          ...tlsView(cfg, { live: await liveTls(cfg), withPairing: url.searchParams.get('pairing') === '1' }),
          observing: OBSERVING,
        });
      }

      /**
       * Turn HTTPS on or off, and fetch the certificate that makes it possible.
       *
       * `{enabled: true|false}`. Pressing it while it is already on is the retry: the
       * setting is rewritten to what it already was and `tailscale cert` is asked
       * again, which is exactly what you want the moment after turning HTTPS
       * Certificates on for the tailnet — the reply says whether it worked without
       * anybody restarting anything to find out.
       *
       * Refused for an observer, and this one is not a formality. A spare-port
       * instance shares `~/.config/beadcause/config.json` with the live daemon, so a
       * press here would move the real `baseUrl`, sign every paired browser out of the
       * real origin, and do it from a process nobody thinks of as the daemon.
       *
       * It does not restart anything. TLS is decided when the listener is created, by
       * whoever owns the port — see lib/tlsswitch.js — so the reply carries
       * `restartNeeded` and the command, and the restart stays a thing you ask for.
       */
      if (p === '/api/tls' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be true or false' });
        const out = await setTls(cfg, {
          enabled: body.enabled,
          live: await liveTls(cfg),
          log: (msg) => console.log(`[beadcause] tls         ${msg}`),
          warn: (msg) => console.error(`[beadcause] tls         ${msg}`),
        });
        console.log(
          `[beadcause] tls         ${out.did.action} by hand — ${out.did.from} → ${out.did.to}` +
            (out.did.asked ? ` (${out.did.asked.ok ? 'certificate ok' : `no certificate: ${out.did.asked.detail}`})` : '')
        );
        return json(res, 200, { ok: true, ...out });
      }

      /**
       * Deploys: what has been run, and what it did.
       *
       * Read-only and off disk, so it answers during a deploy as well as after one —
       * including a deploy that is at that moment killing this very process, which is
       * the case the whole of lib/deploy.js is shaped around. `deployable` is the list
       * of repos the button may be offered for at all; a repo missing from it has no
       * deploy declared, which is not a failure and is most repos.
       *
       * Two things it does that a plain reader would not, both because /prs polls this
       * every few seconds while a deploy is in flight:
       *
       * - **It sweeps first.** The poll's own `settleDeploys` runs every 30 seconds,
       *   which is the right cadence for a notification and much too slow for a screen
       *   somebody is watching a restart on: a runner that died ten seconds ago would
       *   read as still deploying until the poll came round. The sweep only ever writes
       *   a record whose pid is confirmed dead, and the announcement is decided by a
       *   marker file rather than by who noticed — so sweeping here cannot cost a push.
       * - **The list is brief.** See `briefDeploy`: passing steps travel without their
       *   output, which is the difference between a few kilobytes and most of a
       *   megabyte per poll. `?id=` still answers with the whole record and the log.
       */
      if (p === '/api/deploys' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        if (id) {
          const rec = showDeploy(id);
          if (!rec) return json(res, 404, { error: `no deploy ${id}` });
          return json(res, 200, { deploy: rec, log: deployLog(id) });
        }
        sweepDeploys();
        const asked = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(asked) ? Math.min(40, Math.max(1, Math.trunc(asked))) : 20;
        return json(res, 200, { deploys: listDeploys({ limit }).map(briefDeploy), deployable: deployable(cfg) });
      }

      /**
       * What the last deploy did to *you* — the client asking.
       *
       * `/api/deploys` is the journal: every record of every repo, for a screen about
       * deploying. This is the other side of the same disk, cut down to the two facts a
       * client can act on — the page under it moved, and the shell it is running in was
       * rebuilt — plus what the APK on disk now is, so the Android shell can compare it
       * against the build it is. See lib/update.js for why those follow the pull rather
       * than the restart, and why they are only ever about this checkout.
       *
       * Deliberately cheap and deliberately read-only: a directory read and a `stat`,
       * with no sweep. Every page in the app loads public/update.js, so this is asked at
       * every boot; the sweep it does not do is `/api/deploys`', and a boot is not a
       * screen watching a restart.
       */
      if (p === '/api/update' && req.method === 'GET') {
        return json(res, 200, updateView({ deploys: listDeploys({ limit: 20 }) }));
      }

      /**
       * Run this repo's declared deploy — and return before it has happened.
       *
       * The one endpoint whose whole contract is what it does *not* wait for. A
       * beadcause deploy SIGKILLs this process, so awaiting it would mean this reply
       * was never written; `startDeploy` hands the work to a detached runner and comes
       * back with a record that is already on disk. So a 200 here means "it is written
       * down and a process owns it", never "it worked" — the outcome arrives on
       * /api/deploys and, when it settles, on your phone.
       *
       * Refused for an observer for the same reason `POST /api/session` is: a second
       * daemon on a spare port shares the checkouts, and restarting the live one from
       * it is not a thing a spare-port instance should be able to do.
       */
      if (p === '/api/deploy' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const { unit } = requireUnit(body);
        const where = whereLanded(unit.workspace, unit.repo);
        if (!deployFor(cfg, unit.key)) {
          return json(res, 409, { error: `no deploy is declared for ${unit.key} — see \`deploys\` in ${CONFIG_PATH}` });
        }
        const already = runningFor(unit.key);
        if (already) return json(res, 409, { error: `a deploy of ${where} is already running`, deploy: already });
        const rec = beginDeploy(bus, cfg, unit.key, { bead: body.bead || null, reason: String(body.reason || '') });
        console.log(`[deploy] ${where}: started ${rec.id} (pid ${rec.pid})${rec.restarts ? ' — this one restarts beadcause' : ''}`);
        return json(res, 200, { ok: true, deploy: rec });
      }

      /**
       * The survey agent's transcript — the same live log a dispatched reply gets,
       * for the run that decides whether there is any work worth proposing.
       */
      if (p === '/api/advocate-log' && req.method === 'GET') {
        const name = String(url.searchParams.get('workspace') || '');
        if (!advocates.has(name)) return json(res, 404, { error: `no advocate for ${name || '(none given)'}` });
        const key = advocates.logKey(name);
        return json(res, 200, {
          key,
          lines: agentlog.tail(key),
          running: advocates.snapshot().find((a) => a.workspace === name)?.surveying || false,
        });
      }

      /**
       * The dependency graph as data: `{nodes, links}`, or `{empty: true}` for a
       * workspace with nothing open. No `id` means every open issue in the
       * workspace, grouped by connected component.
       *
       * Each node carries its live state as well as its shape — who is on it, when
       * it last moved, what phase an agent reported — so the graph answers "what is
       * happening" and not only "what exists". `since` is the cut-off those marks
       * were measured against and `sinceKind` says how it was chosen, because the
       * phone must not claim "this session" when all it knows is "recently".
       *
       * The drawing happens on the phone (public/graph.js) — see lib/graph.js for
       * why beadcause stopped serving bd's own page.
       *
       * **The `id`-less form is on the shared layer (bc-1kwl.12); the per-bead form
       * is not.** With no `id` this is the whole workspace's graph, one key spelled
       * by code (`graph:<workspace>`, lib/graph.js) — inside lib/cache.js's own rule
       * (lib/cache.js:69-72) — and it was the app's single worst request, 120.1s at
       * the tail. `?id=` stays a direct `bd` call: it is keyed on request input,
       * which is exactly the case that rule is about, and bc-1kwl.12's notes carry
       * the still-open question of what to do about it.
       */
      if (p === '/api/graph' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (id && !BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        let html, rows, keptEnvelope;
        if (id) {
          // Two bd calls, in parallel — uncached, per the note above.
          [html, rows] = await Promise.all([
            bd.graphHtml(ws, id),
            bd.listStatus(ws, 'open,in_progress,blocked').catch(() => []),
          ]);
        } else {
          const got = await workspaceGraph(bd, ws, { refresh: url.searchParams.get('refresh') === '1' });
          ({ html, rows } = got.value);
          keptEnvelope = got;
        }
        const { since, kind } = movedSince(liveSessions(cfg), ws.name);
        // How old this answer is goes on a header, not in the body — see `KEPT_HEADER`
        // in lib/cache.js. Absent for the per-bead form, which is not kept at all.
        if (keptEnvelope) res.setHeader(KEPT_HEADER, describeKept(keptEnvelope));
        return json(res, 200, {
          ...enrichGraph(parseGraph(html), rows, { since, activity: readActivity(), workspace: ws.name }),
          since,
          sinceKind: kind,
          // The client dates every node against this rather than its own clock, so
          // the ages it prints agree with the `moved` flags the server decided.
          now: new Date().toISOString(),
        });
      }

      /**
       * One bead in full, for the graph's detail drawer.
       *
       * Deliberately not /api/question: that shape is a *decision* — parsed options,
       * diagrams, docs — and only makes sense for a `human` bead. Every node in the
       * graph is an ordinary issue, so this hands back what `bd show` knows plus its
       * thread, and lets the client decide what to draw.
       */
      if (p === '/api/bead' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        // **One `bd` spawn for the bead and its thread, not two.** This route used to ask
        // `show` and then `comments`, and the sheet waited on the sum — its own instrument
        // reported `sub: 1.00` at fan-out `1×`, every millisecond spent waiting on one
        // child after another. `Bd.showWithComments` asks once: 13 of 14 paired runs
        // faster, median 1376ms → 1012ms. The note on that method is where the reasoning
        // lives, including why the *obvious* fix — starting the two calls together — was
        // measured and rejected rather than shipped. Caching would beat this again, but
        // it needs bc-nuq3 answered; this needs nothing, because one call and two return
        // the same bytes. See lib/bd.js on `graph` for why spawn count is the whole game.
        let issue;
        try {
          issue = await bd.showWithComments(ws, id);
        } catch (err) {
          // bd 1.1.2 says "no issue found matching" here and "not found" elsewhere.
          if (/no issues? found|not found/i.test(err.message)) return json(res, 404, { error: `no such bead: ${id}` });
          throw err;
        }
        if (!issue) return json(res, 404, { error: `no such bead: ${id}` });
        // Whether anything has decided this bead should happen (bc-rfnr.7). A field here
        // rather than a route of its own — unlike the children beside it — because it
        // costs no `bd` call the sheet would otherwise wait on: the graph is cached and
        // the inbox behind this sheet has just warmed it. `wait: false` for the same
        // reason every read on this path uses it, and a cold cache answers `true`, which
        // is the fail-open the gate itself takes: the sheet draws no adopt row rather
        // than telling you a bead is orphaned on the strength of not having looked.
        const workable = hasRootAbove(await bd.graph(ws, { wait: false }), id);
        // And which model a session on this bead runs, on the same terms as `noRoot`: a
        // derived field rather than a route, because it costs no `bd` call — the labels
        // it reads are already in the row above. The sheet could parse them itself, and
        // deliberately does not: the tier is a label but the model is a *mapping* over
        // it, and lib/complexity.js is the only copy of that mapping. The inbox card
        // gets the identical object off `toQuestion`. See bc-nc6o.5.
        const model = modelCard(issue);
        // And on the same terms again: where the *ruling* is, for the beads anybody rules
        // on. `null` for everything outside deluvia's approval pipeline, so the sheet for
        // an ordinary bead is byte-for-byte what it was. The sheet is also the only
        // surface that can ever draw this field's `problem` — a packet that forgot the
        // `human` label is by construction not in the inbox to be complained about. See
        // lib/approvalcard.js and bc-bmry.5.
        const approval = approvalCard(issue);
        // And the trail a department relay left behind it, on the same terms again: a field
        // rather than a route, parsed out of `notes` this call already returned. `null` for
        // every bead no relay has ever run on, which is all of them outside deluvia's
        // studio — so the sheet for an ordinary bead is what it was. This is the *whole*
        // trail because it is one bead somebody tapped; the tree rows on the board get
        // `relayMark`, which is the last entry alone. See lib/relayjournal.js and bc-bmry.4.
        const relay = relayTrail(issue);
        // The paths this bead declares (bc-42ow.6): read off `issue.description` before
        // `withoutSurface` below takes the block back out of it, so every screen that
        // draws `description` gets prose alone and draws these as their own row of
        // pills instead — `lib/beadfiles.js`'s own docstring calls `withoutSurface` "what
        // a card shows above the machinery", and until this route called it nothing did.
        // `[]` on a bead with no block, which is most of them, and the description comes
        // back byte-for-byte unchanged on those — `withoutSurface` is a no-op without a
        // fence to find.
        const files = declaredFiles(issue);
        return json(res, 200, {
          ...issue,
          workspace: ws.name,
          noRoot: !workable,
          model,
          approval,
          relay,
          files,
          // Already on `issue` and spread above; named again because the sheet's whole
          // second half reads it, and a reader should not have to know that `show` is
          // the thing that now carries it.
          comments: issue.comments,
          description: withoutSurface(issue.description),
        });
      }

      /**
       * What points at a bead — every child, and everything else waiting on it.
       *
       * A route of its own rather than a field on `/api/bead`, because neither half is
       * in `bd show` at all (see `Bd.dependents`) and fetching them is a second `bd`
       * invocation. Folded into `/api/bead` it would be a call every sheet waits on,
       * and most beads you tap are leaves with nothing pointing at them. So the sheet
       * paints from `/api/bead` and asks for this afterwards, appending it when it lands.
       *
       * **One call, split here rather than two calls.** `bd show` gives the sheet
       * `dependent_count` and no rows, so the children block and the "blocks" list were
       * the same missing half of the same payload; asking `dep list --direction=up` once
       * answers both, and the split is a filter on `dependency_type` rather than a
       * second round trip. Children come out marked `parent-child`, which is why they
       * are lifted out of `dependents` instead of being counted twice — the same seven
       * beads under two headings is exactly what this route exists to avoid.
       *
       * An id that does not exist is a 404, the same as `/api/bead`'s. `bd list --parent`
       * used to answer `[]` for one and this route passed that on as two empty lists;
       * `bd dep list` exits non-zero instead, and a bead that has been deleted since the
       * sheet opened is not a broken server. The sheet swallows it either way — it never
       * replaces a bead you can already read with an error over the part that did not
       * arrive — so what this decides is only what the log and a `curl` are told.
       */
      if (p === '/api/bead-links' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        let rows;
        try {
          rows = await bd.dependents(ws, id);
        } catch (err) {
          if (/no issues? found|not found/i.test(err.message)) return json(res, 404, { error: `no such bead: ${id}` });
          throw err;
        }
        return json(res, 200, {
          workspace: ws.name,
          id,
          children: rows.filter((r) => r.dependency_type === 'parent-child'),
          dependents: rows.filter((r) => r.dependency_type !== 'parent-child'),
        });
      }

      /**
       * Who is answerable for this bead — set it, move it, or hand it back to nobody.
       *
       * **A route of its own rather than a field of `/api/bead/adjust`, and the reason is
       * what the two are for.** Adjust rewrites a bead that has not been endorsed yet: it
       * refuses a bead anybody has agreed to work, because rewriting one over a stale
       * queue row is the failure lib/verdict.js exists to prevent. Ownership is the
       * opposite kind of fact — it is most worth changing on an epic that is *live*, months
       * into it, when the person who filed it is no longer the person carrying it. Folded
       * into adjust it would have inherited a refusal that makes no sense here.
       *
       * It is also why `owner:` is protected from the ✎ (`isProtectedLabel`): the sheet
       * posts the label set it is showing, and a handle nobody typed into that box would
       * be removed by the save. Two doors, and only this one moves ownership.
       *
       * **Any bead, not only a root.** The stamp at filing time is root-only (lib/bd.js) —
       * that is where the default belongs, because a root is what somebody has to be
       * answerable for. Refusing to *record* an owner on an ordinary task would be a
       * different claim and a wrong one: a bead turned into an epic next week should not
       * need its ownership re-decided, and bc-rfnr.5's triage sets owners on beads before
       * it raises them. The response says whether this bead is a root so a client can draw
       * the difference.
       *
       * An empty `owner` is a legitimate answer and means nobody — the way a root filed
       * against the wrong person is handed back to triage. `ok: true` with no write at all
       * is the ordinary case for a form that posts on every save; `changed` says which.
       */
      if (p === '/api/bead/owner' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const issue = await loadBead(bd, ws, id);
        const { addLabels, removeLabels } = ownerUpdate(issue, body.owner);
        const changed = addLabels.length > 0 || removeLabels.length > 0;
        // `Bd.update` with nothing in it runs no `bd` at all, so this guard is about the
        // *actor* rather than the cost: attributing a write that did not happen would put
        // a name in the bead's history for a save that changed nothing.
        if (changed) await bd.update(ws, id, { addLabels, removeLabels }, { actor: actorFor(req) });
        const owners = ownersOn({ labels: [...(issue.labels || []).filter((l) => !removeLabels.includes(l)), ...addLabels] });
        return json(res, 200, { workspace: ws.name, id, owner: owners[0] || null, owners, root: isRoot(issue), changed });
      }

      /**
       * Hand this question to somebody else — or to everybody.
       *
       * **The half of the addressee that was missing.** `for:<handle>` is written at the
       * moment a question is filed and by nothing else (bin/ask.js, bin/deliver.js,
       * bin/propose.js and `Bd.create`, all of them from a terminal), which left the
       * ordinary case unreachable: a question lands on your phone, you read it, and it is
       * really Carol's. Before this the only moves were to answer it yourself or to leave
       * it, and neither of those is the true one.
       *
       * **A route of its own, next to `/api/bead/owner` and for its reasons.** `for:` is
       * protected from the ✎ (`isProtectedLabel`) precisely because the sheet posts the
       * label set it is showing and a handle nobody typed into that box would be removed
       * by the save — so the ✎ cannot be the door, and this is. It also inherits that
       * route's shape exactly: post the handle you want, `changed` says whether anything
       * was written, and re-sending the handle the bead already has costs one `bd show`
       * and no `bd` at all.
       *
       * **An empty `to` means everyone**, which is a decision rather than the absence of
       * one: `for:` is what makes a question quiet on five Macs out of six, so taking the
       * labels off is what puts it in front of whoever is free. `everyone` spells it out
       * loud and lands in the same place — see `addresseeLabel`.
       *
       * **And it clears the notification you are handing away, on exactly one condition.**
       * lib/ringing.js already makes this argument for a narrowed filter: a row sitting in
       * your shade for a bead you have just decided is not yours is precisely the mess
       * worth tidying, and the honest limit is the same one — ntfy cannot recall a
       * delivered message, so what is actually cleared is the Android shell's own tray,
       * via the `dismissed` event it cancels on. The condition is `addressedElsewhere`
       * and nothing looser: re-addressing a question to *yourself*, or to everyone, leaves
       * the shade alone, because those are the two answers under which the phone is still
       * being asked. `dismissed` rather than `answered` for that file's reason too —
       * nobody answered anything, the bead stays open, and it is still in your inbox.
       */
      if (p === '/api/bead/addressee' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const issue = await loadBead(bd, ws, id);
        const { addLabels, removeLabels } = addresseeUpdate(issue, body.to);
        const changed = addLabels.length > 0 || removeLabels.length > 0;
        // The `owner` route's guard, for its reason: `Bd.update` with nothing in it runs
        // no `bd`, so this is about the *actor* rather than the cost — attributing a write
        // that did not happen would put a name in the bead's history for a save that
        // changed nothing.
        if (changed) await bd.update(ws, id, { addLabels, removeLabels }, { actor: actorFor(req) });
        // Read back off what the bead now carries rather than off what was asked for. The
        // two differ whenever somebody else moved it first, and a card repainted from the
        // request would show a hand-off that did not happen.
        const labels = [...(issue.labels || []).filter((l) => !removeLabels.includes(l)), ...addLabels];
        const addressees = addresseesOf(labels);
        const key = `${ws.name}/${id}`;
        let cleared = false;
        if (changed && addressedElsewhere(cfg, { labels })) {
          // Only if this daemon actually made the noise. `ringing` is its belief about the
          // shade and nothing else is, so a bead that never rang here has nothing to clear
          // and must not emit an event that would cancel a row somebody else is holding.
          if (loadState().ringing?.[key]) {
            bus.emit({ type: 'dismissed', key, workspace: ws.name, id, reason: 'addressed' });
            cleared = true;
          }
          unring(key);
        }
        if (changed) {
          console.log(
            `[beadcause] ${key} is now ${addressees.length ? `for ${describeAddressees(addressees)}` : 'for everyone'}${
              cleared ? ' — cleared its notification here' : ''
            }`
          );
        }
        return json(res, 200, { workspace: ws.name, id, addressees, changed, cleared });
      }

      /**
       * The roots a bead could be adopted under — what the sheet offers when one is held.
       *
       * bc-rfnr.7 refuses a bead with nothing decided above it, and a refusal whose fix is
       * not on the same screen is the cap lib/advocate.js's own rule forbids: loud, and
       * actionable from the phone that is showing it. This is the list behind that
       * control, and it is deliberately **every open root in the workspace, not only
       * yours** — the gate measures against all of them (lib/underroot.js), so offering a
       * narrower set would mean the sheet could not express half the adoptions that
       * would actually work.
       *
       * Since bc-htoy a root is an epic at any priority as well as a P0, so this list is
       * the one that grew most: the sheet used to offer only the handful of things
       * somebody had called urgent, which is why adopting a stray bead so often meant
       * inventing a P0 to put it under. Each row carries its `priority` so the sheet can
       * say which is which rather than presenting a P0 and a P3 epic as the same offer.
       *
       * Off the cached graph, which the inbox has usually just warmed, and `wait: true`
       * unlike the inbox's own read: this is a tap rather than a repaint, and a cold
       * cache answering `[]` would draw "there is nothing to adopt under" over a tracker
       * full of epics. A second and a half on the rare cold one is the right side of that
       * trade.
       */
      if (p === '/api/roots' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const { beads } = await bd.graph(ws);
        const roots = [...rootsOf(beads)]
          .map((id) => beads.get(id))
          .filter(Boolean)
          .map((b) => ({
            id: b.id,
            title: b.title,
            priority: b.priority ?? null,
            epic: isEpic(b),
            owners: ownersOn(b),
            mine: ownedByMe(cfg, b),
          }))
          // Yours first — on a shared graph most roots belong to somebody else, and the one
          // you are adopting under is almost always one of your own. Then by id, so the
          // list is stable between two taps rather than reordering under a thumb.
          .sort((x, y) => Number(y.mine) - Number(x.mine) || String(x.id).localeCompare(String(y.id), 'en', { numeric: true }));
        return json(res, 200, { workspace: ws.name, roots });
      }

      /**
       * The beads a typed fragment matches — what the inbox's search box drops down.
       *
       * **Every workspace at once, not one.** The box sits in the same panel as the space
       * picker and is asked before it: you type `rfnr` because you know the bead, not
       * because you have first remembered which tracker it is in. Each suggestion carries
       * its `workspace/id` key, so picking one is unambiguous even where two trackers
       * hold the same id.
       *
       * **Off the cached graph, and `wait: false`.** This is the one route in the app that
       * can be asked six times in a second — once per keystroke, debounced but still
       * typed-at speed — so it is the one route that absolutely must not be able to spawn
       * a `bd export`. The measurement is on `Bd.graph`: 7.3 seconds across the nine
       * workspaces configured here. The inbox's own epic board warms all of them with the
       * same `wait: false` on every load, so in practice the graph is in hand before
       * anybody has reached the panel.
       *
       * **`warming` is what makes that honest.** A workspace whose export has not landed
       * yet answers an empty shape, and an empty shape is indistinguishable from a
       * workspace with nothing in it — so a cold daemon would tell you your bead does not
       * exist. `warming` counts the workspaces that have never been read, and the client
       * says "still reading the tracker" rather than "no match" while it is above zero.
       * The alternative was `wait: true`, and seven seconds on a keystroke is not a
       * search box.
       *
       * **Not a field on `/api/questions`.** The obvious alternative was to ship the whole
       * id-and-title index with the inbox payload and match on the phone. Measured on this
       * tracker on 2026-08-14: 938 beads in `beadcause` alone, 97KB of `{id,title}` JSON —
       * times nine workspaces, on every 25-second poll, to answer a question that is asked
       * for about four seconds a week. A query goes the other way: one small request per
       * word typed, and nothing at all on the polls where nobody is searching.
       */
      if (p === '/api/beads' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '');
        const rows = [];
        let warming = 0;
        for (const [name, ws] of workspaces) {
          if (!bd.graphReady(ws)) warming += 1;
          const { beads } = await bd.graph(ws, { wait: false });
          for (const b of beads.values()) rows.push({ ...b, workspace: name });
        }
        return json(res, 200, { beads: searchBeads(rows, q, { limit: SEARCH_LIMIT }), warming, q });
      }

      /**
       * One bead and everything under it, as inbox keys — what a picked bead narrows to.
       *
       * bc-qid9 asked whether picking a bead in that box shows only that bead or its whole
       * tree, and this route is the second answer. It is the one the rest of the app
       * already gives: the epic board keys every row by the root it descends from, and a root
       * card expands into every descendant at any depth. A filter that showed one bead and
       * hid its six children would be the only place in the inbox where "this piece of
       * work" meant one row.
       *
       * **Descendants only** — `treeUnder` walks `parent-child` edges and nothing else, so
       * a `discovered-from` trail does not drag half the backlog in. That is the same
       * guarantee bc-rfnr.2 needed, from the same function, and lib/filing.js putting a
       * `discovered-from` on everything an agent files is why it is worth saying twice.
       *
       * **Keys and not ids**, because that is what the list is keyed by and the client has
       * no business rebuilding `workspace/id` in a second place.
       *
       * `wait: true`, unlike the search above: this is a tap rather than a keystroke, it
       * happens once per pick, and a cold cache answering "nothing is under this" would
       * narrow the list to a single row and look exactly like a working filter.
       */
      if (p === '/api/bead/tree' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const { parents, beads } = await bd.graph(ws);
        if (!beads.has(id)) return json(res, 404, { error: `no such bead: ${id}` });
        const tree = treeUnder(childrenFrom(parents), beads, id);
        return json(res, 200, {
          workspace: ws.name,
          id,
          title: beads.get(id)?.title || '',
          // The bead's own key first: picking a bead shows that bead, and the tree under
          // it. One array rather than a row plus a list, because every caller wants the
          // union and building it in two places is how the two come to disagree.
          keys: [`${ws.name}/${id}`, ...tree.map((row) => `${ws.name}/${row.id}`)],
        });
      }

      /**
       * Adopt a bead under a root — the fix for the one refusal that never clears itself.
       *
       * Every other reason a bead is held resolves on its own: a window closes, a pull
       * request merges, an epic's children get done, another Mac's claim expires. "Nothing
       * decided above this" waits for somebody to decide the work belongs somewhere, and
       * this is that decision arriving from a phone.
       *
       * **The parent is checked against the open roots rather than merely existing**, and
       * the refusal names which of the two it failed: adopting a bead under something that
       * is itself an orphan moves it without making it workable, which is the most
       * disappointing possible outcome for a control whose entire promise is that the
       * bead becomes workable. A parent under an open root is allowed, though — a bead
       * belongs beneath the epic it is part of, not directly under the root — so the test
       * is `hasRootAbove`, the same predicate the gate itself asks.
       *
       * Since bc-htoy that predicate accepts an epic at any priority, so this control
       * finally offers what it always implied: the sheet lists every open epic rather than
       * the handful somebody had called urgent, and adopting no longer means inventing a
       * P0 to adopt under.
       *
       * An empty `parent` detaches instead, and is not checked: putting a bead back where
       * nothing has decided it is always a legitimate thing to say, and it is how an
       * adoption into the wrong epic is undone.
       */
      if (p === '/api/bead/adopt' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const parent = String(body.parent || '').trim();
        if (parent && !BEAD_ID_RE.test(parent)) return json(res, 400, { error: 'not a bead id' });
        if (parent === id) return json(res, 400, { error: 'a bead cannot be its own parent' });
        // 404s for an id the tracker does not have, before anything is written.
        await loadBead(bd, ws, id);
        if (parent) {
          const index = await bd.graph(ws);
          if (!index.beads.get(parent)) return json(res, 404, { error: `${parent} is not a bead in ${ws.name}` });
          if (!hasRootAbove(index, parent)) {
            return json(res, 409, {
              error: `${parent} has nothing decided above it either, so adopting ${id} under it would not make it workable`,
            });
          }
        }
        await bd.adopt(ws, id, parent, { actor: actorFor(req) });
        // The board and the gate both read `Bd.graph`, which `adopt` has just refreshed —
        // so the answer here is the state the next tick will act on rather than a promise
        // about it. `workable` is what the sheet redraws from.
        const index = await bd.graph(ws);
        return json(res, 200, { workspace: ws.name, id, parent: parent || null, workable: hasRootAbove(index, id) });
      }

      /**
       * The ledger — every bead this space has ever had, newest-updated first, paged.
       *
       * The one endpoint here that is about the *past*. Everything else in this chain
       * answers a question about now: what is asking you something, what is running,
       * what is waiting on a tap. A bead that closed last week was reachable only by
       * remembering its id and typing it into `/graph`, while three hundred closed beads
       * in this repo carried the best writing in the tracker in their close reasons. The
       * record existed and nothing displayed it. This is the read side of the History
       * tab — see [the ledger behind it](#the-ledger-behind-the-history-tab).
       *
       * **Every filter is honoured or refused, never dropped.** A bad `status` or
       * `priority` is a 400 naming the word, because a filter that silently matched
       * nothing would draw an empty list under a control that says otherwise — and an
       * empty ledger is exactly what a space with no beads looks like. The one thing
       * clamped rather than refused is an oversized `limit`: the set it asks for is
       * right, only the page is too big for a phone. Everything else about how the
       * parameters are read, and why the filtering and paging happen in this process
       * instead of in `bd`, is lib/history.js.
       *
       * **`refresh=1` skips the ten-second sweep cache**, the same way `/api/unendorsed`
       * does. Without it a filter chip, four presses of it and a whole infinite scroll
       * cost one `bd` call between them, which is the point of the cache — and it is a
       * bigger point than it looks: that sweep is ~1s over the largest workspace on an
       * idle Mac and was measured at 28.6s under a load average of 33, which is an
       * ordinary afternoon here. A cold page is genuinely slow; every page after it, for
       * ten seconds, costs nothing. See `Bd.listAll` for what that does to its timeout.
       *
       * Nothing here writes, nothing here is refused on an observer, and there is no
       * `OBSERVING` guard for the same reason `/api/graph` has none — reading the record
       * is not acting on it.
       */
      if (p === '/api/history' && req.method === 'GET') {
        const { picked, workspace, space } = ledgerWorkspaces(url.searchParams);
        const { query, error } = parseLedgerQuery(url.searchParams);
        if (error) return json(res, 400, { error });
        const out = await beadLedger(bd, picked, query, {
          // One `git for-each-ref` per workspace per sweep, cached with the rows — never
          // a lookup per row. See `archivedBeads`. `ws.dir` is the beads database rather
          // than the checkout, which is what `resolveSessionDir` is for; getting that
          // wrong would silently mark every row as having no session.
          archivedFor: (ws) => archivedBeads(resolveSessionDir(cfg, ws)),
          refresh: url.searchParams.get('refresh') === '1',
        });
        // **How old this answer is goes on a header, not in the body**, and this is the
        // route that decides that for the four converting after it (bc-1kwl.3): not every
        // route on the layer answers with an object, so a body-level field would need an
        // envelope at each call site and would change what every existing client parses.
        // See `KEPT_HEADER` in lib/cache.js for the format and the argument.
        const { kept, ...body } = out;
        if (kept) res.setHeader(KEPT_HEADER, describeKept(kept));
        // `workspace` echoes what was asked for and is `''` for a space or for all of
        // them — the rows carry their own, so a merged list can still label them. `query`
        // rides along because the client draws its own filter chrome from the URL and a
        // clamped `limit` is the one value it did not choose.
        return json(res, 200, { workspace, space, query, ...body });
      }

      /**
       * Put an Epic Advocate on this epic — the button on the inbox card.
       *
       * **The first one, and the enrolment.** bc-rfnr.3 argued the agent should be re-opened
       * on child events and nothing did it for a fortnight; lib/reenter.js does it now, and
       * what it enrols an epic on is the waiting-on sentence *this* window writes before it
       * exits. So the tap is not a weaker version of the loop — it is what starts one, and
       * it stays the fallback for the epic whose advocate died before writing anything down.
       *
       * `rememberAdvocateOpened` is module state in lib/epicadvocate.js rather than a `Map`
       * in this file for exactly that reason: two doors open these windows now, and a card
       * that showed "opening" for one of them and offered the button again for the other
       * would be offering a control whose only outcome is the 409 below.
       *
       * **Never two on one epic.** `liveSessions` is matched on the window name, which
       * carries the bead id — the same discipline lib/advocate.js keeps and for the same
       * stated reason: it knows it launched a window for a bead, it does not know that a
       * given `claude` process is that window. So this is a 409 rather than a promise, and
       * the honest failure is refusing a second one you asked for rather than opening it.
       *
       * `OBSERVING` blocks it, unlike the verdict routes: those are you deciding, and this
       * one is the daemon acting — an observer instance must not open windows.
       *
       * The four refusals in front of it live in `openEpicAdvocateSession`, and all four
       * come back as a 409 with a sentence: unendorsed, superseded, closed, or not a root
       * anybody owns. A button that silently does nothing is worse than one that says why.
       */
      if (p === '/api/bead/advocate' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        // `advocateSession` and not a `name.includes(id)` of its own, so this door and the
        // card in front of it are the same rule: a session on `bc-d6yk.1` used to refuse an
        // advocate on `bc-d6yk` — the child-prefix match lib/reap.js's `namesBead` exists to
        // stop — while the card, which knows better, went on offering the button. The
        // `opening` half counts too: it is a launch of ours from a minute ago, and a second
        // window is exactly what it is there to prevent.
        // The half this does not fix: the console draws the daemon's own windows and this
        // reads every `claude` process, so "there already is one" and "I cannot see one"
        // can both be true — bc-xl7n.8.1.
        const already = advocateSession(liveSessions(cfg), id, { openedAt: openedRecently(`${ws.name}/${id}`) });
        if (already) {
          return json(res, 409, {
            error: already.opening
              ? `${id} already has an advocate opening — give the window a moment to come up`
              : // The window's own name, in the sentence rather than only in the payload:
                // a refusal that names what is holding the bead can be acted on from the
                // phone reading it, and "which session?" was the first question it raised.
                `${id} already has a session open on it — “${already.name}”. One advocate per epic, never two.`,
            live: already.name || null,
            pid: already.pid,
          });
        }
        const row = await loadBead(bd, ws, id);
        // The plan and the children it is being asked to take stock of. Both read here
        // rather than inside the brief for `workPromptFor`'s reason: the brief stays a
        // pure function of its arguments, which is what lets a test assert every branch
        // of it without a tracker.
        const [kids, plan] = await Promise.all([
          bd.children(ws, id).catch(() => []),
          readPlan(bd, ws, id).catch(() => null),
        ]);
        const opened = await openEpicAdvocateSession(cfg, ws, row, {
          kids,
          plan: plan ? formatPlan(plan) : null,
          reason: 'somebody asked for you from the epic card on the phone',
          bd,
        });
        // Remembered *here*, after the window is up, because that is the fact being
        // recorded — a launch that threw opened nothing and must leave the button alone.
        // It is what puts "an advocate is opening" on the card through the minute before
        // the session has renamed itself into something `namesBead` can find.
        rememberAdvocateOpened(`${ws.name}/${id}`);
        // **And this is where the tap becomes the assignment** — bc-r2b5.1. Before it, the
        // only record of an assignment was the waiting-on sentence the window this just
        // opened is asked to write before it exits, so a window that died first left
        // nothing and the same button had to be pressed again. The label is written the
        // moment the window is up, on the bead rather than in `advocates.json`, and
        // lib/reenter.js enrols on it — see `ADVOCATE_LABEL`.
        //
        // After the launch and not before, because the four refusals in front of it are
        // real: an epic enrolled by a launch that was refused is one the sweep would
        // re-argue every three hours for ever. And reported rather than thrown from — the
        // window is open, and a 500 over the top of it would say the tap did nothing.
        let assigned = true;
        if (!isAssigned(row)) {
          try {
            await bd.addLabel(ws, id, ADVOCATE_LABEL);
          } catch (err) {
            assigned = false;
            console.warn(`[beadcause] ${ws.name}/${id}: window is up but the assignment was not recorded — ${err.message.split('\n')[0]}`);
          }
        }
        console.log(`[beadcause] Epic Advocate opened on ${ws.name}/${id}`);
        bus.emit({ type: 'advocate', key: `${ws.name}/${id}`, workspace: ws.name, id });
        return json(res, 200, { workspace: ws.name, id, opened: true, assigned, repo: opened.repo || null });
      }

      /**
       * Start a P0 — the picker's tap on the board. bc-s8mc.
       *
       * `{workspace, id}` in, `{workspace, id, started, status}` out, and every refusal a
       * 409 carrying the sentence to draw. What it writes and why each refusal is there is
       * `boardMove`; what makes the card appear without a reload is the graph refresh
       * inside `Bd.setStatus` plus the `p0board` event above — the phone that tapped
       * re-polls immediately and every other device is woken off its parked log request.
       *
       * A route of its own rather than an `action` on one, the way the four verdicts are
       * four paths: this one and the one under it are opposite writes, they are read off
       * the source by `assertRoutes`, and a body naming the wrong one of two strings would
       * take an epic off the board where the tap said to put it on.
       */
      if (p === '/api/bead/start' && req.method === 'POST') {
        return json(res, 200, await boardMove(await readBody(req), { on: true }));
      }

      /**
       * Take a P0 off the board — back to `open`, still owned, still yours, still there.
       *
       * The reverse of the tap above and deliberately the same shape. It is *not* pausing
       * the epic's advocate (bc-lco2), which leaves it started and stops dispatch under
       * it; this one is only about what leads the screen, and the two are meant to be
       * usable independently.
       */
      if (p === '/api/bead/unstart' && req.method === 'POST') {
        return json(res, 200, await boardMove(await readBody(req), { on: false }));
      }

      /**
       * The endorsement queue: every bead an agent filed that nobody has looked at yet.
       *
       * Every workspace at once, newest first, and no `workspace` parameter — the space
       * picker in the top bar decides what is drawn, client-side, the same way the PR
       * board does (see `inSpace` in public/prs.js and public/endorse.js). Narrowing on
       * the server would mean the picker could not move without a round trip, and the
       * whole list is a handful of rows.
       *
       * `?refresh=1` skips the few-second cache. What the four verdict routes below do
       * to that cache is drop it outright — see `announceVerdict`. Since bc-1kwl.3 that
       * cache is lib/cache.js, so the fifteen-second window now ends in a kept answer
       * and a sweep behind the response rather than a 48-second wait; the drop on a
       * verdict is unchanged and is still what takes a judged bead off every device.
       *
       * The rows are fat on purpose and the reason is in lib/endorsequeue.js: this is
       * the one screen where the decision *is* reading the bead.
       */
      if (p === '/api/unendorsed' && req.method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1';
        // `waitMs: CACHE_WAIT_MS` — bc-774a2, the same opt-in `/api/prs` and `/api/queues`
        // take. This is a phone waiting on a cold key, and it gains nothing from inheriting
        // the sweep's own 150-second slot: `errors[]` in the answer already has somewhere
        // honest to say "the Mac is busy", and the sweep this gave up on keeps running and
        // still lands in the keep. Without it the wait ran to the ceiling and the throw came
        // out of the catch-all as an HTTP 500, which the page files a P0 incident about.
        const { kept, ...body } = await endorsementQueue(bd, scopedWorkspaces(), { refresh, waitMs: CACHE_WAIT_MS });
        // On the header, out of the body — the convention /api/history set. See `KEPT_HEADER`.
        if (kept) res.setHeader(KEPT_HEADER, describeKept(kept));
        return json(res, 200, body);
      }

      /**
       * The four verdicts on a bead nobody has endorsed yet — endorse, revoke, adjust,
       * ask for changes. What each one means and what it leaves behind is lib/verdict.js;
       * what is here is the door.
       *
       * **Four routes and not one `verdict` parameter.** They are four different acts
       * with four different bodies and four different ways of being wrong — a revoke
       * closes a bead, an adjust rewrites six fields, and a body that named the wrong
       * one of those in a string would be one typo away from the other. The chain reads
       * them as four greppable paths, which is also how they are asserted (test/routes.mjs).
       *
       * All four take `{ workspace, id }` or `{ workspace, ids: [...] }`, and all four
       * answer the same shape: `ok` as a flag, `results` as a row per bead in the order
       * they were asked for, `applied` as the ids that actually moved, and `failed` with
       * a reason on each. A group where one bead lost a lock race is a 200 carrying five
       * applied ids and one failure, not a failed request — see `statusFor`.
       *
       * No observe-mode guard on any of them. `OBSERVING` is about the daemon acting on
       * its own — opening sessions, shipping — and these are you deciding, in the same
       * category as `/api/respond`. What an observer instance still cannot do is open a
       * session on what it just endorsed, which is guarded where that happens.
       */
      if (p === '/api/bead/endorse' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const { ids, error } = verdictIds(body);
        if (error) return json(res, 400, { error });
        // Nothing else to validate: endorsing is the one verdict with no argument, and
        // deliberately the one that cannot fail for being repeated.
        const out = await applyVerdict(bd, ws, { verdict: 'endorse', ids });
        announceVerdict(ws, out);
        return json(res, statusFor(out), { workspace: ws.name, ...verdictBody(out) });
      }

      /**
       * Revoke: closed, with your reason on the close, and the marker left where it is.
       *
       * The reason is optional because a one-tap revoke on an obviously-wrong bead
       * should not demand a sentence, and defaulted rather than left empty because
       * `bd show` three weeks later prints that line and "closed" on its own answers
       * nothing. Bounded like every other free-text field that ends up in a `bd`
       * argument.
       */
      if (p === '/api/bead/revoke' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const { ids, error } = verdictIds(body);
        if (error) return json(res, 400, { error });
        const typed = String(body.reason || '').trim().slice(0, 2000);
        const reason = typed ? `${REVOKED_PREFIX} — ${typed}` : REVOKED_REASON;
        const out = await applyVerdict(bd, ws, { verdict: 'revoke', ids, reason });
        announceVerdict(ws, out);
        return json(res, statusFor(out), { workspace: ws.name, reason, ...verdictBody(out) });
      }

      /**
       * Adjust: the bead as you would have written it, still held unless you say
       * otherwise.
       *
       * `edits` is the same six fields the proposal card's ✎ offers, through the same
       * clamps (`normalizeEdits`). `endorse: true` is "adjusted, and yes, work on it" —
       * one tap, one decision, and the only way an adjust may be aimed at a bead that
       * is no longer held.
       *
       * **A title may not be set on a group.** Every other field means something
       * sensible applied to six beads at once — they are all P3, they all belong to the
       * same label — but six beads with one title is not a thing anybody has ever
       * wanted, and the one client that would send it is a client with a stale form.
       */
      if (p === '/api/bead/adjust' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const { ids, error } = verdictIds(body);
        if (error) return json(res, 400, { error });
        const edits = normalizeEdits(body.edits || body);
        const alsoEndorse = body.endorse === true || body.endorse === 'true';
        if (edits.title && ids.length > 1) {
          return json(res, 400, { error: 'one title cannot be given to several beads' });
        }
        if (!Object.keys(edits).length && !alsoEndorse) {
          return json(res, 400, { error: `nothing to adjust — edits may name ${EDITABLE.join(', ')}` });
        }
        const out = await applyVerdict(bd, ws, { verdict: 'adjust', ids, edits, endorse: alsoEndorse, actor: actorFor(req) });
        announceVerdict(ws, out);
        return json(res, statusFor(out), { workspace: ws.name, edits, ...verdictBody(out) });
      }

      /**
       * Ask for changes: your objection on the thread, the bead left held.
       *
       * The note is required, and that is the whole verdict — a "changes requested" with
       * nothing said is indistinguishable from having done nothing, except that it looks
       * to the next session like the bead was considered. Written as you rather than as
       * the daemon: this one is a sentence a person said, and the next session that
       * reads the thread should see whose.
       */
      if (p === '/api/bead/changes' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const { ids, error } = verdictIds(body);
        if (error) return json(res, 400, { error });
        const note = String(body.note || body.text || '').trim().slice(0, 8000);
        if (!note) return json(res, 400, { error: 'note is required — asking for changes is the note' });
        const out = await applyVerdict(bd, ws, { verdict: 'changes', ids, note, actor: actorFor(req) });
        announceVerdict(ws, out);
        return json(res, statusFor(out), { workspace: ws.name, ...verdictBody(out) });
      }

      /**
       * Talk about a held bead instead of deciding on it — a comment, and an agent sent
       * to answer it. lib/discuss.js is the whole argument; what is here is the door.
       *
       * **Not a fifth verdict, and deliberately not on the verdict shape.** The four
       * above each take a list, because "endorse these five" is a thing a busy week
       * produces. A discussion takes exactly one id: a question typed at six beads is a
       * question about none of them, the same reason group adjust and group
       * ask-for-changes are refused on the client. So this answers `{ ok, id, thread }`
       * rather than `{ results, applied, failed }` — the fields a conversation has.
       *
       * **The bead is untouched.** No label, no status, no marker moved — the only write
       * is the comment, and `say` refuses outright if the bead has been endorsed since
       * the queue was drawn. What comes back carries `held` so a row that has gone stale
       * under a thumb can redraw as one rather than as a thread that worked.
       *
       * The queue cache is dropped for the comment count alone: `bd list` carries
       * `comment_count`, the folded row draws it (`toRow`), and a row that still said
       * "no thread" a few seconds after you started one is the exact thing acceptance
       * asks for — that a bead under discussion never reads as untouched.
       */
      if (p === '/api/bead/discuss' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const { ids, error } = verdictIds(body);
        if (error) return json(res, 400, { error });
        if (ids.length > 1) {
          return json(res, 400, { error: 'a discussion is with one bead — ask them one at a time' });
        }
        const id = ids[0];
        const text = String(body.text || body.note || '').trim().slice(0, DISCUSS_MAX);
        if (!text) return json(res, 400, { error: 'text is required — the comment is the discussion' });

        // Throws 404 for a bead that is gone and 409 for one already endorsed, both of
        // which the outer catch turns into that status with the reason on it.
        const said = await say(bd, ws, id, { text, actor: actorFor(req) });
        forgetQueue();
        bus.emit({ type: 'discussion', key: `${ws.name}/${id}`, workspace: ws.name, id, title: said.title });

        // From here on it is the same dispatch `/api/comment` makes, with one flag: the
        // agent is told the bead is held and that this thread is not what endorses it.
        // Resolved the same way the dispatcher will, so an unknown id from a stale phone
        // cannot arm one agent and elevate another.
        const chosen = agentFor(cfg, body.agent ? String(body.agent) : null);
        const elevated = armedTools.has(chosen.id);
        const dispatch = await dispatchReply(cfg, ws, id, said.title, {
          agentId: chosen.id,
          elevated,
          bd,
          // The row `say` already read, rather than a second `bd show` for the same bead
          // one line later — the dispatcher wants it only to notice a thread that is
          // itself an amendment request.
          issue: said.issue,
          held: true,
        });
        if (elevated && dispatch.dispatched) armedTools.delete(chosen.id);
        console.log(
          `[beadcause] discussing ${ws.name}/${id} with ${chosen.name}${
            dispatch.dispatched ? '' : ` — no agent dispatched: ${dispatch.reason}`
          }`
        );

        return json(res, 200, {
          ok: true,
          workspace: ws.name,
          id,
          held: true,
          dispatched: dispatch.dispatched,
          agent: dispatch.agent || { id: chosen.id, name: chosen.name },
          // Why nobody is coming, when nobody is: auto-dispatch off for this workspace,
          // an agent already mid-reply on this bead, or an observer instance standing
          // down. A comment that silently gets no answer is the failure the whole
          // dispatch feature exists to fix.
          reason: dispatch.dispatched ? null : dispatch.reason || null,
          elevated: Boolean(dispatch.elevated),
          thread: await threadOf(bd, rosterNow(), ws, id),
        });
      }

      /**
       * The thread on one bead, and whether an agent is still writing into it.
       *
       * Two things in one answer because the queue asks for both together and for the
       * same reason: nothing pushes a reply on a held bead. `checkReplies` only walks
       * `allQuestions()` — `bd human` beads — so an unendorsed bead's thread is pull-only
       * by construction, and the page polls this while `running` is true. Folding the
       * activity in here is what keeps that one request rather than two, and what lets
       * the row say *which* agent is thinking rather than only that something is.
       *
       * Not `/api/bead`, which is `bd show` plus the thread for the graph drawer: this is
       * the cheap half, one `bd comments`, called on a timer.
       */
      if (p === '/api/bead/thread' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const key = `${ws.name}/${id}`;
        const activity = activityFor(key, [], readActivity());
        return json(res, 200, {
          workspace: ws.name,
          id,
          thread: await threadOf(bd, rosterNow(), ws, id),
          // The same test `/api/agent-log` makes, so the two never disagree about
          // whether the phone should still be waiting.
          running: Boolean(activity && activity.phase !== 'done' && activity.phase !== 'blocked'),
          activity,
        });
      }

      /**
       * The decisions on a JIRA ticket — approve, cancel, the beadify that undoes a
       * cancel, and the forget that drops a cancel whose ticket is gone (bc-0i27.19).
       * lib/jiragate.js is the whole argument; what is here is the door. **Discuss is deliberately not among them**: the row hands you to
       * `/api/bead/discuss` on the ticket's own epic, because that path already exists
       * and a second one would be the parallel approval system bc-0i27.14 refuses.
       *
       * They take `{ workspace, key }` — the *ticket* key, never a bead id — for the
       * reason lib/jiracancel.js is keyed that way: the bead may not exist yet, and on
       * a machine whose `bd create` has been failing all morning it may never have. The
       * one thing a row always has is the ticket it is about.
       *
       * No observe-mode guard, exactly as on the four verdict routes above: `OBSERVING`
       * is about the daemon acting on its own, and these are you deciding.
       */
      /**
       * The ticket itself, read — what the view over the tab opens with (bc-0i27.6).
       *
       * A `GET`, and the only one of the four that is: nothing about opening a ticket
       * decides anything, and a read behind a POST is a read a browser will not cache,
       * retry or reason about. It takes the ticket key like its three neighbours, plus
       * the epic the client already has on the row — passed in rather than looked up,
       * because `lib/jiraepic.js` owns that answer and re-deriving it here would cost a
       * `bd list --all` on a tap that had the id in hand.
       *
       * **Deliberately not the whole ticket.** The summary, the status and when it last
       * moved are on the row the view was opened from and refresh on the ordinary inbox
       * poll; sending them again here would be two copies of one fact, disagreeing by
       * one poll interval. What comes back is the half a row cannot carry — the
       * description, the thread, and the beads written under the epic.
       *
       * A JIRA that will not answer is a field rather than a status: the epic, the
       * children and the row's own facts are all still worth the screen, and the one
       * thing lost is the description. See lib/jiraview.js.
       */
      if (p === '/api/jira/ticket' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const key = jiraKey(url.searchParams.get('key'));
        if (!key) return json(res, 400, { error: `not a JIRA key: ${String(url.searchParams.get('key') || '')}` });
        const epic = String(url.searchParams.get('epic') || '').trim();
        if (epic && !BEAD_ID_RE.test(epic)) return json(res, 400, { error: 'not a bead id' });
        return json(res, 200, await ticketView(bd, ws, cfg, key, { epic }));
      }

      /**
       * Approve: the epic **and its children**, in one act.
       *
       * Not `/api/bead/endorse` with the epic's id, which is the shape a phone could
       * have assembled for itself — because it could not. Which beads make up the
       * ticket is a `bd list --parent` at this end of the wire, and an approve that
       * endorsed the container and left the work held is a ready queue with a bead in
       * it and nothing to do in it.
       */
      if (p === '/api/jira/approve' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const key = jiraKey(body.key);
        if (!key) return json(res, 400, { error: `not a JIRA key: ${String(body.key || '')}` });
        const out = await approveTicket(bd, ws, key, { filer: jiraEpics });
        // The same announcement the four verdicts make — one event per bead — so a
        // laptop watching the endorsement queue drops the rows too.
        announceVerdict(ws, out);
        bus.emit({ type: 'jira', key: ws.name, workspace: ws.name, state: 'approved', detail: `${key} approved` });
        console.log(
          `[jira] ${ws.name}: ${key} approved — ${out.ok.length}/${out.results.length} endorsed under ${out.epic}`
        );
        return json(res, statusFor(out), {
          workspace: ws.name,
          key,
          epic: out.epic,
          children: out.children,
          truncated: out.truncated,
          ...verdictBody(out),
        });
      }

      /**
       * Cancel: the earmark that never expires, and the epic closed beside it — unless
       * it has already been approved, which leaves it exactly where it is.
       */
      if (p === '/api/jira/cancel' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const key = jiraKey(body.key);
        if (!key) return json(res, 400, { error: `not a JIRA key: ${String(body.key || '')}` });
        const out = await cancelTicketAndEpic(bd, ws, key, { filer: jiraEpics, actor: actorFor(req) });
        // The row leaves the inbox on the event, and the endorsement queue loses the
        // epic on the cache drop — two screens, one decision.
        forgetQueue();
        bus.emit({ type: 'jira', key: ws.name, workspace: ws.name, state: 'cancelled', detail: `${key} cancelled` });
        console.log(`[jira] ${ws.name}: ${key} cancelled — epic ${out.epic || 'none'} ${out.bead}`);
        return json(res, 200, { ok: true, workspace: ws.name, key, ...out });
      }

      /**
       * Beadify: the reverse of cancel, and the reason cancel can be absolute. The
       * button that calls it belongs to the ticket view (bc-0i27.6); the act is here
       * because it is the other half of the record.
       */
      if (p === '/api/jira/beadify' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const key = jiraKey(body.key);
        if (!key) return json(res, 400, { error: `not a JIRA key: ${String(body.key || '')}` });
        const out = await beadifyTicket(bd, ws, key, { filer: jiraEpics, ingester: jiraIngest });
        forgetQueue();
        bus.emit({ type: 'jira', key: ws.name, workspace: ws.name, state: 'beadified', detail: `${key} beadified` });
        console.log(
          `[jira] ${ws.name}: ${key} beadified — ${
            out.restored ? `earmark lifted, ${out.bead || 'no bead'}` : 'was not cancelled'
          }`
        );
        return json(res, 200, { ok: true, workspace: ws.name, ...out });
      }

      /**
       * Forget: drop a cancel record whose ticket the poller can no longer find.
       *
       * The fourth door onto a ticket and the only one that does not go through
       * `requireWorkspace`, which is deliberate and is the whole reason this route
       * exists rather than beadify being pointed at the fold. A record is stranded
       * *because* nothing answers for it any more, and the commonest way to get there is
       * the workspace itself leaving the config — so resolving the name against
       * `workspaces` would 400 on exactly the records this is here to clear. The name is
       * therefore taken as the string it is stored as, validated only for the two things
       * `cancelKey` needs of it: that it is there, and that it holds no slash.
       *
       * Nothing here touches `bd`. The epic the cancel closed stays closed, because the
       * ticket is not coming back and reopening it would leave a held bead with no row
       * anywhere to decide about it — that is beadify's job and beadify's promise, and
       * this is the other answer. See `forgetCancel` in lib/jiragate.js, which is also
       * where the 409 on a ticket that has come back is argued.
       */
      if (p === '/api/jira/forget' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.workspace || '').trim();
        if (!name || name.includes('/')) return json(res, 400, { error: `not a workspace name: ${name || '(empty)'}` });
        const key = jiraKey(body.key);
        if (!key) return json(res, 400, { error: `not a JIRA key: ${String(body.key || '')}` });
        const out = forgetCancel(name, key, { tickets: jira.tickets() });
        bus.emit({ type: 'jira', key: name, workspace: name, state: 'forgotten', detail: `${key} record dropped` });
        console.log(
          `[jira] ${name}: ${key} cancel record ${out.forgotten ? `dropped (${out.bead || 'no bead'})` : 'was already gone'}`
        );
        return json(res, 200, { ok: true, ...out });
      }

      /**
       * The dispatched agent's log, as the CLI would have shown it.
       *
       * Read-only and file-backed, so it survives the request that started the run
       * and can be opened long after — and so a phone that polls it every couple of
       * seconds costs a file read rather than anything to do with `bd`.
       */
      if (p === '/api/agent-log' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const key = `${ws.name}/${id}`;
        const activity = activityFor(key, [], readActivity());
        return json(res, 200, {
          key,
          lines: agentlog.tail(key),
          // What the client needs to decide whether to keep polling: an agent that
          // has finished leaves its log behind, and a stale poll is pure waste.
          running: Boolean(activity && activity.phase !== 'done' && activity.phase !== 'blocked'),
          phase: activity?.phase || null,
        });
      }

      /**
       * What an advocate's sessions left in the repo — see lib/sessionlog.js.
       *
       * Two modes on one path: `id` lists the archived sessions for a bead, `commit`
       * reads one of them back. Read-only, and it never leaves the repo it belongs
       * to: `file` is restricted to the names the archive itself writes, so a
       * crafted value cannot walk into arbitrary tree content.
       */
      if (p === '/api/session-archive' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const dir = resolveSessionDir(cfg, ws);
        const commit = String(url.searchParams.get('commit') || '');

        if (commit) {
          if (!/^[0-9a-f]{7,40}$/i.test(commit)) return json(res, 400, { error: 'not a commit id' });
          const file = String(url.searchParams.get('file') || 'session.log');
          // `memory.md` is on the list before anything writes one, and deliberately: it
          // is what the archived-session page leads with, and a reader that has to be
          // opened in the same change as the writer is a reader nobody can test. A tree
          // that does not carry it answers 404 here and the page never asks — it is told
          // which files exist by `/api/bead-session` below.
          if (!['session.log', 'meta.json', 'memory.md', 'transcript.jsonl'].includes(file)) {
            return json(res, 400, { error: 'no such file in a session archive' });
          }
          const text = await readArchived(dir, commit, file);
          if (text === null) return json(res, 404, { error: 'nothing archived under that commit' });
          return json(res, 200, { commit, file, text });
        }

        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        return json(res, 200, { workspace: ws.name, id, ...(await readArchive(dir, id)) });
      }

      /**
       * One **finished** session, addressed by bead — everything `/session?pid=` cannot be.
       *
       * `/api/session-log` resolves a running process and 404s once the pid has gone, which
       * is the right answer for a live session and no answer at all for a bead that closed
       * in June. This is the archived counterpart: the workspace and the bead are the whole
       * address, because a bead outlives every process that ever worked it.
       *
       * One request for the lot, for the same reason that endpoint carries the whole record
       * rather than just the transcript — and here there is a second reason. The page shows
       * three things that are each absent independently: the memories the session left, the
       * log it wrote, and where its worktree went. `session.files` is the tree listing, so
       * the page says "not available" because it was **told** the file is not there, rather
       * than by firing a read and rendering the shape of the failure. That is the difference
       * between a section that says nothing is there and a link that opens an empty pane.
       *
       * The archived text itself is not in here. It comes back through
       * `/api/session-archive?commit=&file=` above, which is already the only place allowed
       * to name a file inside one of these trees — so a log is one extra request, made only
       * when the listing said there is one.
       *
       * `pr` costs a `gh` call and is therefore **opt-in on `?pr=1`**, which the page asks
       * for in a second request once it has drawn. It is the one fact here that is not a
       * local file read, and a phone opening this page should not wait on the network to be
       * told that a directory has been tidied away — nor should the sections that say
       * "not available" depend on GitHub being reachable to say it. Reads only: nothing on
       * this path writes, and `gh pr view` is the only thing it does off this machine.
       */
      if (p === '/api/bead-session' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const dir = resolveSessionDir(cfg, ws);
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const commit = String(url.searchParams.get('commit') || '');
        if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) return json(res, 400, { error: 'not a commit id' });
        const detail = await readSessionDetail(dir, id, {
          commit: commit || null,
          usePr: url.searchParams.get('pr') === '1',
        });
        return json(res, 200, { workspace: ws.name, id, ...detail });
      }

      /**
       * One live session: what it is, and its own Claude Code transcript, tailed.
       *
       * Addressed by **pid**, never by path: the pid is matched against the sessions
       * the page itself just reported, and the file is resolved from the record
       * Claude Code wrote. So a request cannot name a file, and a transcript can only
       * be read for a process that is running right now.
       *
       * A pid that has gone is a 404 saying so rather than an empty pane — you tapped
       * a row for a session that exited between the refresh and the tap, and "it
       * finished" is a different fact from "it has done nothing".
       *
       * The whole record goes out, not only the three fields the transcript needed.
       * `/session?pid=…` (public/session.js) is a page of its own — reached from
       * /sessions, from /advocates and from the mirror — and it has no `/api/work`
       * payload to have taken the cwd, the workspace and the start time out of. One
       * request for the lot also means the facts and the transcript on that page can
       * never disagree about which conversation the process is on, which matters
       * because `/clear` gives it a new one without the pid changing.
       *
       * It also carries **`reach`** — whether this session can be typed into, and the
       * sentence to show when it cannot. That rides along rather than sitting on an
       * endpoint of its own for the same reason the record does: the page draws its
       * composer from the same response that drew the facts, so it can never offer a
       * box for a session it has just been told is out of reach. See `sessionReach`.
       *
       * And it is the **lease** on a window held up at double size. This poll is the
       * only evidence that anybody still has this session's page open, so it is what
       * keeps such a window big — a phone that locks, a tab that is swiped away or a
       * page Chrome discarded all stop polling, and lib/focus.js puts the window back
       * once the lease lapses. `focused` rides back for the same reason `reach` does: the
       * button is drawn from the response that drew the facts, so a page reloaded
       * while the window is big says "put it back" rather than offering to enlarge a
       * window that already is.
       */
      if (p === '/api/session-log' && req.method === 'GET') {
        const pid = Number(url.searchParams.get('pid'));
        // Re-read rather than cache: `/clear` rewrites the record with a new session
        // id, and the pane must follow the conversation the process is actually on.
        const session = liveSessions(cfg).find((s) => s.pid === pid);
        if (!session) return json(res, 404, { error: `no session running as pid ${pid || '(none given)'}` });
        const { file, lines } = tailTranscript(cfg, session);
        touchFocus(pid);
        return json(res, 200, {
          ...session,
          // Where it looked, so an empty pane can say why it is empty.
          file,
          lines,
          reach: await sessionReach(pid),
          focused: isHeld(pid),
        });
      }

      /**
       * Show me that session on the Mac — and put it back afterwards.
       *
       * The one thing this page could not do. It tails a transcript and types into a
       * session, and finding *which of a dozen worktree windows* you were reading about
       * meant going through iTerm's window list by hand. So: `action: 'focus'` raises
       * that window and doubles it in place, `action: 'restore'` returns it to the exact
       * rectangle it had before. lib/focus.js holds the rectangle and the header there
       * is the design.
       *
       * Gated on **the same `reach`** the composer is, and for the same reason: a
       * session in Terminal.app, tmux or over ssh has no iTerm window to raise, and a
       * button that did nothing would be worse than a sentence saying why. The page
       * draws both from `/api/session-log`, so the two can never disagree.
       *
       * **`restore` is not gated on anything**, deliberately, and does not require the
       * session to still be running. It arrives by `sendBeacon` from a page being torn
       * down, it arrives twice when a close races the lease sweep, and it must work for
       * a window whose session exited while it was big — which is the window most in
       * need of being put back. Nothing held is `restored: false`, not an error.
       *
       * No observe-mode guard, matching `/api/session-say` rather than `/api/session`:
       * `OBSERVING` is about the daemon acting on its own — opening windows, shipping,
       * killing workers — and this is you asking to be shown something you are already
       * looking at. It moves no work and changes no state that outlives the window.
       */
      if (p === '/api/session-focus' && req.method === 'POST') {
        const body = await readBody(req);
        const pid = Number(body.pid);
        if (!Number.isInteger(pid) || pid <= 0) return json(res, 400, { error: 'no session named' });

        if (body.action === 'restore') {
          const { restored } = await putBack(pid);
          return json(res, 200, { ok: true, focused: false, restored });
        }

        const session = liveSessions(cfg).find((s) => s.pid === pid);
        if (!session) return json(res, 404, { error: `no session running as pid ${pid}` });

        const reach = await sessionReach(pid);
        if (!reach.can) return json(res, 409, { error: reach.why, reach });

        const result = await bringUp(pid, reach.tty);
        if (!result.ok) {
          return json(res, 409, {
            error: `That window has closed — ${reach.tty} is no longer an iTerm session.`,
          });
        }
        console.log(
          `[beadcause] ${result.again ? 'raised' : 'raised and doubled'} pid ${pid}'s window on ${reach.tty}`
        );
        return json(res, 200, { ok: true, focused: true, again: !!result.again });
      }

      /**
       * Say something to a live session — the one conversation in this app that was
       * already on your screen and could not be answered.
       *
       * Every other chat here is one beadcause started, so it owns a process and can
       * write to its stdin. A session you started at the keyboard is a TUI in a window
       * this daemon does not own, and `write text` into its iTerm session is the whole
       * channel; `scripts/message-session.applescript` has the detail. The reply needs
       * no channel at all, because the transcript pane above is already tailing the
       * file the session writes — which is why this returns as soon as the words are
       * delivered and does not wait for an answer it has no way to recognise.
       *
       * Three things it refuses to do quietly, because "nothing typed is lost without
       * being told" was the whole point of the bead:
       *
       *   - **Gone** is a 404 naming the pid, not a silent success.
       *   - **Out of reach** is a 409 carrying the same `why` the page was already
       *     showing, so an unreachable session cannot be typed into by a stale tab.
       *   - **The window closed between the two** is `missing` from the AppleScript,
       *     and also a 409 — the send genuinely did not happen.
       *
       * There used to be a fourth — **flattened** — because `write text` pressed return
       * at the end of a line and a message with two paragraphs in it went as one. It
       * does not any more: the AppleScript pastes the text and presses Return once, so
       * paragraphs arrive as paragraphs and submit as a single turn. The field is gone
       * rather than hardcoded to `false`, and an old cached page reading it gets
       * `undefined`, which is falsy, which is the truth.
       *
       * `queued` is the mid-turn answer the bead asked for, and it is a statement
       * about the session rather than about this daemon: Claude Code accepts typing
       * while a turn is running and answers it when the turn lands, so the honest
       * word is "queued, by the session" — not refused, and not dropped. Read from
       * the record at send time, so it describes the turn the words actually met.
       *
       * No observe-mode guard. `OBSERVING` is about the daemon acting *on its own* —
       * opening sessions, shipping, killing workers — and this is you typing, in the
       * same category as the in-app terminal and the bead console, which an observer
       * instance is booted precisely to try. See lib/config.js.
       */
      if (p === '/api/session-say' && req.method === 'POST') {
        const body = await readBody(req);
        const pid = Number(body.pid);
        // Trimmed at the ends and nowhere else: the newlines in the middle are the
        // message now, not a hazard to close up.
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'nothing to say' });
        // The message still rides to `osascript` as a command-line argument, so ARG_MAX
        // is still the real ceiling however many lines it is split over. Past it
        // `osascript` fails as "could not reach that session" — which reads as *the
        // session* is gone, and is a lie about the one thing this endpoint must not lie
        // about. Said plainly and well short of the real limit, with the words left in
        // the box.
        if (text.length > SAY_MAX) {
          return json(res, 413, {
            error: `Too long to type into a session — ${text.length} characters, and the limit is ${SAY_MAX}.`,
          });
        }

        const session = liveSessions(cfg).find((s) => s.pid === pid);
        if (!session) {
          return json(res, 404, { error: `no session running as pid ${pid || '(none given)'}` });
        }

        const reach = await sessionReach(pid);
        if (!reach.can) return json(res, 409, { error: reach.why, reach });

        const result = await messageSession(reach.tty, text);
        if (result === 'missing') {
          return json(res, 409, {
            error: `That window has closed — ${reach.tty} is no longer an iTerm session.`,
          });
        }

        const lines = text.split('\n').length;
        console.log(
          `[beadcause] said ${text.length} chars${lines > 1 ? ` over ${lines} lines` : ''} to pid ${pid} on ${reach.tty}`
        );
        return json(res, 200, {
          ok: true,
          // What went, exactly — and now that is also what was typed. The page shows it
          // back as "sent, line breaks and all", which is a claim this field has to be
          // able to support.
          sent: text,
          queued: session.status === 'busy',
        });
      }

      /**
       * What publishing this document to Confluence would do — asked before anything
       * happens, and asked again by the POST below.
       *
       * The reader tab calls this on every open, so the *unconfigured* answer has to
       * be cheap and it has to be silent: `confluenceSettings` returns null without
       * touching the token file, this returns `{ configured: false }`, and the page
       * draws no button at all. A button that exists and then explains it cannot work
       * is the failure this is written the other way round to avoid.
       *
       * Configured, it costs two GETs to Atlassian — the space, and a search for a
       * page with this title — because the one thing the screen must be able to say
       * before you press is whether this creates a page or replaces one that is
       * already there, with a link to it.
       *
       * Only a document `/api/asset` would serve can be published, through the same
       * `assetPath`, so publishing can never reach a file the reader tab cannot: the
       * roots are the config's, the realpath is resolved before it is checked, and the
       * extension has to be one of the three that are prose. A `.pdf` is servable and
       * is deliberately not publishable — there is no markdown in it to render.
       */
      if (p === '/api/confluence' && req.method === 'GET') {
        const conf = confluenceSettings(cfg);
        if (!conf) return json(res, 200, { configured: false });

        const real = await assetPath(url.searchParams.get('p'));
        if (!PUBLISHABLE_EXT.has(path.extname(real).toLowerCase())) {
          return json(res, 200, { configured: true, publishable: false, why: 'only markdown and text documents can be published' });
        }
        const workspace = String(url.searchParams.get('workspace') || '');
        const text = await fsp.readFile(real, 'utf8');
        const plan = await confluenceTarget(cfg, { workspace, filePath: real, text, state: loadState() });
        return json(res, 200, { configured: true, problem: confluenceProblem(cfg), ...(plan || { publishable: false, why: 'no Confluence API token' }) });
      }

      /**
       * And the act. One press, one page — and never anything else.
       *
       * **The confirmation is checked, not trusted.** The body carries the space key
       * and the page title exactly as the screen drew them, and lib/confluence.js
       * refuses with a 409 if either has moved since. That is what makes "the target
       * was named before it happened" true of the daemon rather than of the client:
       * edit the document's `# heading` between the draw and the press and this
       * refuses, instead of quietly creating a second page under the new name.
       *
       * **An observer may not press it.** Its line is acts on the machine, and this is
       * further out than that — a page on a wiki other people read, which no restart
       * takes back. `POST /api/space` and `POST /api/deploy` are the precedent.
       *
       * **The URL is recorded twice, on purpose.** Once in `state.json`, which is what
       * makes the *next* publish an update rather than a duplicate, and once as a
       * comment on the bead when one is named — because a bead is where somebody looks
       * for "where did this end up", and beadcause's own state is not somewhere they
       * can look at all.
       */
      if (p === '/api/confluence' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const real = await assetPath(body.p);
        if (!PUBLISHABLE_EXT.has(path.extname(real).toLowerCase())) {
          return json(res, 415, { error: 'only markdown and text documents can be published' });
        }
        const workspace = String(body.workspace || '');
        const text = await fsp.readFile(real, 'utf8');
        const actor = actorFor(req);

        let record;
        try {
          record = await confluencePublish(cfg, {
            workspace,
            filePath: real,
            text,
            state: loadState(),
            actor,
            confirm: { spaceKey: String(body.spaceKey || ''), title: String(body.title || '') },
          });
        } catch (err) {
          return json(res, err.status || 500, { error: err.message });
        }

        // Written before the bead is told, and that order is the whole of it: the page
        // exists by now, and the one thing that must not be lost is its id — without it
        // the next publish of this document makes a second page. A comment can be
        // retried by hand; a duplicate page is found by somebody else, later.
        const remember = () =>
          saveState({ published: prunePublished({ ...loadState().published, [confluencePublishKey(real)]: record }) });
        remember();
        console.log(
          `[beadcause] ${record.action === 'create' ? 'created' : 'updated'} ${record.spaceKey}/${record.title} on ${record.site} from ${record.file}`
        );

        // The bead half, and it is best-effort on purpose: the page exists by now, and
        // failing the request over a comment would tell the phone the publish did not
        // happen when it did. It is said in the log instead.
        if (body.bead && workspace) {
          try {
            const ws = requireWorkspace(workspace);
            await bd.comment(
              ws,
              String(body.bead),
              `Published to Confluence: [${record.title}](${record.url}) in ${record.spaceKey}.\n\nFrom ${record.file}. Re-publishing that document updates this same page.`,
              { actor }
            );
            record.bead = `${ws.name}/${body.bead}`;
            // Again, so the record on disk says which bead was told. Cheap, and it keeps
            // `state.json` and the answer this route gives from disagreeing.
            remember();
          } catch (err) {
            console.warn(`[beadcause] published ${record.url} but could not comment on ${workspace}/${body.bead} — ${err.message}`);
          }
        }

        return json(res, 200, { ok: true, ...record });
      }

      if (p === '/api/asset' && req.method === 'GET') {
        const real = await assetPath(url.searchParams.get('p'));
        const stat = await fsp.stat(real);
        res.writeHead(200, {
          'content-type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'private, max-age=60',
        });
        return fs.createReadStream(real).pipe(res);
      }

      return json(res, 404, { error: 'no such endpoint' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[beadcause]', err.message);
      return json(res, status, { error: err.message });
    }
  };

  // Boot fails rather than one screen going quietly blank. See assertRoutes.
  assertRoutes(handler);

  return {
    handler,
    allQuestions,
    foundationRequests,
    agentBeads,
    warmKeys,
    forgetInbox,
    splitChannels,
    bd,
    hooks,
    bus,
    advocates,
    auditor,
    syncer,
    publisher,
    epicWatch,
    strandWatch,
    orphanWatch,
    jira,
    jiraEpics,
    jiraResolved,
    jiraIngest,
    runMergeQueue,
  };
}

/**
 * Every `(method, path)` this handler answers to, read off its own source.
 *
 * There is no route table to read instead — routing here is one long chain of
 * `if (p === '…' && req.method === '…')`, which is deliberate (it is greppable, it
 * keeps each route next to the paragraph explaining it, and a new route is an
 * insertion that conflicts with nobody). What it does not have is the one property a
 * table gets for free: a duplicate key is not an error, it is dead code. So the table
 * is derived from the text of the function at boot, which costs one regex over a few
 * hundred kilobytes, once.
 *
 * The pattern is matched in both orders, because both are written below, and only
 * literal single-quoted paths are seen — a computed path (`p.startsWith('/api/')`,
 * the static file fallthrough) is not a fixed key and cannot collide with one.
 * Missing a route here is safe; inventing one would not be, which is why this reads
 * exact string equality and nothing looser — and why the `if (` is part of the
 * pattern: the same comparison quoted in a comment above a route is not a route, and
 * a boot that dies over a sentence would be a worse bug than the one being prevented.
 *
 * This is deliberately the same read `test/routes.mjs` makes over the file on disk,
 * and that file asserts the two agree. A regex that quietly stops matching turns this
 * check into a no-op that still passes, and the suite is the only place that can
 * notice: a floor here would mean the daemon refusing to boot the day someone
 * legitimately changes how routes are written.
 */
export function routeTable(handler) {
  const src = String(handler);
  const routes = [];
  const forms = [
    /if \(\s*p === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'/g,
    /if \(\s*req\.method === '([A-Z]+)'\s*&&\s*p === '([^']+)'/g,
  ];
  for (const [i, re] of forms.entries()) {
    for (const m of src.matchAll(re)) {
      const [path, method] = i === 0 ? [m[1], m[2]] : [m[2], m[1]];
      routes.push(`${method} ${path}`);
    }
  }
  return routes;
}

/**
 * Refuse to start with the same `(method, path)` registered twice.
 *
 * bc-dwqh: `GET /api/foundation` was registered twice — the foundation channel and
 * the agent detail, nine hundred lines apart, at the same brace depth. The first
 * returned, the second never ran, and the Foundations detail screen threw on every
 * open for as long as that was true. Nothing said so: not the suite (its fake server
 * answered the *client's* contract, so it stayed green), not the log, not the
 * response — a 200 with the wrong body reads as working.
 *
 * A duplicate is never intentional, so this throws rather than warns, and it throws
 * at `createApp` rather than on the first request: launchd's KeepAlive turns a boot
 * crash into a loud restart loop with the reason in the log, which is exactly the
 * volume this failure wanted and never had.
 */
export function assertRoutes(handler) {
  const seen = new Set();
  const dupes = [];
  for (const route of routeTable(handler)) {
    if (seen.has(route)) dupes.push(route);
    else seen.add(route);
  }
  if (dupes.length) {
    throw new Error(
      `[beadcause] route registered twice, so the later one is dead code: ${[...new Set(dupes)].join(', ')}`,
    );
  }
  return [...seen];
}

/**
 * Watch for newly-flagged questions and push them once each, and for agent
 * replies to questions you've commented on.
 */
export function startPoller(cfg, app) {
  const state = loadState();
  let notified = new Set(state.notified || []);
  let counts = state.commentCounts || {};
  let first = true;

  // Conversations nobody came back to. Once at startup: a console is cheap to keep
  // and there is no hurry, but a year of them is a directory nobody wants to read.
  pruneConsoles();

  /**
   * A sweep in this cycle failed, has been logged, and the cycle carries on — as it must,
   * because none of these may be allowed to stop the others. This is what turns the ones
   * that were *bugs* into a bead as well; see lib/crash.js, where the bar sits.
   *
   * Fire-and-forget on purpose, in two senses. Not awaited, because a `bd create` in the
   * middle of a poll tick would delay the next sweep by seconds over a failure already
   * handled; and the promise is dropped rather than caught, because `reportSweepFailure` is
   * documented never to reject. That second one matters more than it looks — a dropped
   * promise that *could* reject would be an `unhandledRejection`, which lands in the crash
   * handler, about the crash handler.
   */
  const sweepFailed = (label, err) => {
    reportSweepFailure(label, err);
  };

  app.hooks.rebaseline = (key, count) => {
    counts[key] = count;
    saveState({ notified: [...notified], commentCounts: counts });
  };

  /**
   * "We wrote one comment and could not read the new total."
   *
   * The fallback for a baseline that failed on the Dolt lock. A key with no baseline
   * yet is left alone on purpose: `checkReplies` skips a thread it has never counted,
   * so inventing a number here would be the only way to *cause* the notification this
   * is preventing.
   */
  app.hooks.countedOne = (key) => {
    if (counts[key] === undefined) return;
    counts[key] += 1;
    saveState({ notified: [...notified], commentCounts: counts });
  };

  // Mark a question as already-pushed without ever pushing it. Used by /api/ask:
  // a question you filed from your own phone is already on your screen.
  app.hooks.suppressPush = (key) => {
    notified.add(key);
    saveState({ notified: [...notified], commentCounts: counts });
  };

  /**
   * A comment from anyone other than the phone is an agent talking back.
   *
   * Only questions you've replied to are watched. `bd human list` carries no
   * comment count, and a comment doesn't move `updated_at`, so detecting this
   * costs one `bd comments` call per watched question per tick — bounded to the
   * handful you're actually waiting on rather than the whole inbox.
   */
  async function checkReplies(questions, filter, rang, account = null) {
    for (const q of questions.filter((x) => x.awaitingAgent)) {
      const ws = cfg.workspaces.find((w) => w.name === q.workspace);
      let comments = [];
      try {
        comments = await app.bd.comments(ws, q.id);
      } catch {
        continue;
      }
      const seen = counts[q.key];
      counts[q.key] = comments.length;
      if (seen === undefined || comments.length <= seen) continue;

      // Not `c.author !== cfg.actor`, which is what this was and what it can no longer
      // be: a daemon that knows who it is writes as `beadcause (carol@example.com)`, so
      // a string comparison would read its own relayed comments as an agent talking
      // back and buzz the phone about them. `writtenByDaemon` compares the *base* — and
      // recognises the other five machines' bylines too, which the old test could not
      // have, so another engineer's tap on a shared thread stays bookkeeping rather
      // than arriving here as an answer. See lib/byline.js.
      const incoming = comments.slice(seen).filter((c) => c.author && !writtenByDaemon(c.author, cfg));
      if (!incoming.length) continue;

      const latest = incoming[incoming.length - 1];
      // Emit before pushing: the app's own notification should not be gated on
      // ntfy.sh being reachable.
      //
      // A reply is as quiet as the bead it is on — the account it belongs to as much as
      // the filter, which is why both are handed in rather than re-read here.
      // Answering the filter separately
      // here would be the one way a filtered-out bead could still reach the phone:
      // you narrow the inbox to one workspace, hear nothing about a question in
      // another — and then get buzzed the moment an agent says something on it.
      //
      // Which is also why a reply on a foundation request is *not* quietened by the
      // filter: the bead it is on isn't, so `quietReasonFor` says so from the same
      // `q.foundation` the card carries, and this call site needs no branch of its own.
      const reason = quietReasonFor(cfg, filter, q, new Date(), account);
      const replyQuiet = Boolean(reason);
      app.bus.emit({
        // Its own type, all the way down. A client keeping the two channels apart
        // has to be able to file this reply against the right pane without going
        // back to the server to ask which one the bead was in.
        type: q.foundation ? 'foundation-reply' : 'reply',
        key: q.key,
        workspace: q.workspace,
        id: q.id,
        title: q.question || q.title,
        author: latest.author,
        text: latest.text || '',
        space: q.space || null,
        quiet: replyQuiet,
        // Which of the two kinds of quiet, for a client that wants to draw them
        // apart. Additive and null when it made a noise, so anything that only
        // knows about `quiet` behaves exactly as it did.
        quietReason: reason,
      });
      if (replyQuiet) {
        console.log(
          reason === 'filtered'
            ? `[beadcause] reply on ${q.key} from ${latest.author} arrived quietly (outside the inbox filter: ${describeFilter(filter)})`
            : `[beadcause] reply on ${q.key} from ${latest.author} arrived quietly (${q.space} is muted right now)`
        );
      } else {
        // A reply is a row in the same tray, under the same bead key, so it is a
        // notification the filter can later offer to clear. Recorded off the *event*
        // rather than off the push below, because the shell's notification comes from
        // the event and does not wait on ntfy being reachable.
        rang[q.key] = rangFor(q);
        try {
          // pushReply reports `{skipped:true}` when ntfy is off, and it usually is —
          // nothing subscribes to the relay; the phone long-polls /api/poll instead.
          // Logging "pushed" regardless claimed a notification had left the machine
          // when none had, which is the worst kind of log line to debug against.
          const sent = q.foundation
            ? await pushFoundationReply(cfg, q, latest)
            : await pushReply(cfg, q, latest);
          if (sent?.skipped) console.log(`[beadcause] reply on ${q.key} from ${latest.author} (ntfy off — clients poll for it)`);
          else console.log(`[beadcause] pushed reply on ${q.key} from ${latest.author}`);
        } catch (err) {
          console.error(`[beadcause] reply push failed for ${q.key}: ${err.message}`);
          // Inside the per-question loop, so this is the one swallowed failure in the poll
          // that the outer report cannot see. Almost always ntfy being unreachable, which
          // `reportSweepFailure` filters out; a TypeError in here would otherwise be
          // swallowed once per reply, forever.
          sweepFailed('the reply push', err);
        }
      }
      // An agent has answered you, so you're no longer the one waiting.
      try {
        await app.bd.removeLabel(ws, q.id, REPLIED_LABEL);
      } catch {
        /* label may already be gone */
      }
    }
  }

  const tick = async () => {
    let questions;
    try {
      // Forced (bc-1kwl.7): this is the sweep bc-1kwl.5's change detector triggered
      // because something on disk actually moved, and it decides what to push-notify
      // by diffing against `notified` — a cached, pre-change answer here would mean a
      // beat that skips its own reason for running. `refresh: true` is also what keeps
      // `questions:<workspace>` warm for every request between beats, at no extra cost:
      // this call was happening every cycle already.
      questions = await app.allQuestions({ refresh: true });
    } catch (err) {
      console.error('[beadcause] poll failed:', err.message);
      // And, if it was a bug rather than a locked tracker, a bead about it. Every catch
      // in this cycle is right to carry on — none of these sweeps may stop the others —
      // but "logged every thirty seconds for a week with nobody reading it" is how a
      // TypeError in a background sweep survives. See lib/crash.js for where the bar is.
      sweepFailed('the poll', err);
      return;
    }
    const live = new Set(questions.map((q) => q.key));
    /**
     * A question that arrived here quietly because it was somebody else's, and is not
     * any more.
     *
     * The other end of `POST /api/bead/addressee`. Handing a question to Carol takes it
     * off the sender's phone in one write; putting it on *hers* is this, and it is not
     * automatic, because `notified` is every live key at the end of every sweep — her
     * daemon swept this bead the day it was filed, kept quiet about it because it was
     * addressed to somebody else, and would never look at it again. Without this the
     * hand-off is half a feature: the card is in her inbox, silent, under a note saying
     * it was asked of the person who has just stopped being asked.
     *
     * Narrow on purpose, and every clause is load-bearing. Only a bead this daemon
     * recorded as quiet *for the addressee reason* — a muted space and a narrow filter
     * are the other two and neither of them is undone by a label — and only when the
     * bead is no longer addressed elsewhere, which on an install with no `cfg.me` is a
     * branch that cannot be entered at all. It fires once: ringing puts the key in
     * `rang`, and `rang` is dropped out of the quiet map at the foot of this sweep.
     */
    const quietForSomebodyElse = loadState().quiet || {};
    const handedToMe = (q) => quietForSomebodyElse[q.key]?.reason === 'addressed' && !addressedElsewhere(cfg, q);
    const fresh = questions.filter((q) => !notified.has(q.key) || handedToMe(q));

    if (first) {
      // Don't fire a burst of pushes for the backlog on startup.
      first = false;
      notified = live;
      // Baseline the watched conversations so a restart doesn't re-push old replies.
      for (const q of questions.filter((x) => x.awaitingAgent)) {
        const ws = cfg.workspaces.find((w) => w.name === q.workspace);
        try {
          counts[q.key] = (await app.bd.comments(ws, q.id)).length;
        } catch {
          /* leave unset; next tick baselines it */
        }
      }
      saveState({ notified: [...notified], commentCounts: counts });
      const waitingAsks = fresh.filter((q) => q.foundation).length;
      if (fresh.length - waitingAsks) {
        console.log(`[beadcause] ${fresh.length - waitingAsks} question(s) already waiting — see ${cfg.baseUrl}`);
      }
      // Counted apart even here. A restart is the one moment the whole backlog is
      // read out at once, and "12 questions waiting" hiding a request to change what
      // an agent is would be the log line agreeing with the mistake this bead exists
      // to stop.
      if (waitingAsks) {
        console.log(`[beadcause] ${waitingAsks} foundation request(s) waiting on you — see ${cfg.baseUrl}`);
      }
      return;
    }

    // What the inbox is narrowed to, which is an input to whether the phone rings
    // rather than only to what the list draws. Read off disk on every sweep that can
    // push, because the phone writes it the moment a chip is pressed — and reconciled
    // on the way in for the reason spelled out in reconcileFilter: there is no client
    // in this loop to correct a stale value, and here a stale value is silence rather
    // than a chip drawn wrong.
    const saved = loadState();
    const filter = reconcileFilter(
      summarise(cfg, questions),
      cfg.workspaces.map((w) => w.name),
      saved.filter
    );
    // The level above the filter, read off the same disk read and for the same reason:
    // which of your lives the app is currently about (lib/accounts.js). Null on every
    // install that has configured no accounts, and null is the value every predicate
    // over it answers "in scope" to — so a daemon that has never heard of accounts runs
    // this loop exactly as it did before they existed.
    const account = activeAccount(cfg, saved);

    // What rang *on this sweep*, and only that. Deliberately not a copy of the stored
    // set: a sweep takes seconds of `bd`, and in that window a tap on the phone can
    // clear a row or answer a bead. Collecting the additions and merging them over
    // whatever is on disk at save time makes those two writers agree — a removal
    // during the sweep stays removed, rather than being resurrected by a snapshot
    // taken before it happened.
    const rang = {};
    // And the other outcome, collected the same way and for the same reason: what
    // arrived on this sweep *without* making a noise, and which of the two reasons it
    // was. The card is the only surface that could ever say so — see lib/hushed.js.
    const hushed = {};

    for (const q of fresh) {
      // A quiet space still emits the event — the phone must file the card and
      // show the badge — it just carries `quiet`, which tells every client not to
      // make a noise. Suppressing the event instead would hide the question
      // outright, which is a much worse failure than an unwanted buzz.
      //
      // A foundation request is quiet on the same terms as everything else in its
      // workspace. It is tempting to argue that a constitutional decision should
      // ignore a muted space because it is rare and important — but "important
      // enough to override the mute" is exactly the reasoning that makes a mute
      // untrustworthy, and an agent asking to be different has been waiting for a
      // session anyway. It can wait for the evening to end.
      //
      // The inbox filter is the second way to be quiet, and it earns the same
      // contract rather than a suppression of its own: a bead outside the filter
      // still arrives, still files, still counts, and turns up the moment the filter
      // is widened. A filter you can only see the effect of by missing something is
      // not a filter anyone would trust.
      //
      // **And that contract is what exempts the foundation channel from the filter,
      // where the mute reaches it** (bc-8on). "Turns up the moment the filter is
      // widened" is the whole of what makes a quiet bead safe, and it says nothing
      // about a request the inbox never hid: that pane is drawn above the list and
      // outside every filter on it, so a filtered-out request was visible on the
      // screen and silent on the phone at once, with no widening left that could put
      // it back. A mute is a fact about your evening and applies to everything; the
      // filter is a fact about which life you are in, and an agent's definition is not
      // in one of them. `quietReasonFor` in lib/spaces.js is where that lives.
      const reason = quietReasonFor(cfg, filter, q, new Date(), account);
      const quiet = Boolean(reason);
      app.bus.emit({
        // The distinct event type. Everything downstream — the phone's pane, the
        // terminal monitor's pane, the Android shell's notification channel —
        // branches on this rather than on a label it would have to re-read.
        type: q.foundation ? 'foundation-request' : 'question',
        key: q.key, workspace: q.workspace, id: q.id,
        title: q.question || q.title, space: q.space || null, quiet,
        // Which of the two kinds of quiet. A card the filter hid and a card a mute
        // quietened are different facts about why the phone stayed dark, and a
        // client that wants to say so needs to be told which. Null when it made a
        // noise; a client that only knows about `quiet` is unaffected.
        quietReason: reason,
        // Only a foundation request has one, and it is what the pane draws its
        // headline from: which agent, and how narrow the ask is.
        ...(q.foundation ? { agent: q.amendment?.agent || null, scope: q.amendment?.scope || null } : {}),
        // A bead that has been round this loop before. Carried on the event as well as
        // on the card, because the notification is the surface where the mistake is
        // actually made: a row in the shade saying *asked again* is what stops the
        // answer being retyped from the lock screen. Null for everything else, so a
        // client that has never heard of it is unaffected.
        answeredBefore: q.answeredBefore || null,
      });
      if (quiet) {
        // Four reasons, four lines. "Somebody else was asked", "in your other account",
        // "filtered out" and "muted right now" are different things to read at 2am when
        // you are working out why the phone stayed dark: one is fixed by switching
        // account, one by pressing All, one by waiting, and one is not yours to fix at
        // all — it is on another engineer's phone, which is the whole of what you want
        // to know before you go back to sleep.
        console.log(
          reason === 'addressed'
            ? `[beadcause] ${q.key} arrived quietly (addressed to ${describeAddressees(q.addressees) || 'somebody else'})`
            : reason === 'account'
              ? `[beadcause] ${q.key} arrived quietly (outside ${describeAccount(account)})`
              : reason === 'filtered'
                ? `[beadcause] ${q.key} arrived quietly (outside the inbox filter: ${describeFilter(filter)})`
                : `[beadcause] ${q.key} arrived quietly (${q.space} is muted right now)`
        );
        // The same two facts, kept for the card rather than for the log — the filter as
        // it stood included, because by the time you read the card it has moved and the
        // one thing you cannot reconstruct is what it was hiding you from.
        hushed[q.key] = quietArrival(reason, q, filter, new Date(), account?.email || null);
        continue;
      }
      // It rang. Written down so that narrowing the filter later can offer to clear
      // it — the one thing a filter change could never do before was tidy up after
      // the noise it had already made. See lib/ringing.js.
      rang[q.key] = rangFor(q);
      try {
        // Same as above: say what actually happened. The event has already been
        // emitted, so a skipped push is not a lost question — only a quiet one.
        const sent = q.foundation ? await pushFoundationRequest(cfg, q) : await pushQuestion(cfg, q);
        // Say so in the log too. Reconstructing this from the log afterwards is what
        // took an afternoon on bc-goo.2: three identical "arrived" lines, with nothing
        // saying that two of them were the same question coming back.
        const ago = q.answeredBefore ? answeredAgo(q.answeredBefore.at) : '';
        const again = q.answeredBefore ? ` — asked again${ago ? `, you answered it ${ago}` : ', you have answered it before'}` : '';
        const what = q.foundation ? `foundation request ${q.key}` : q.key;
        if (sent?.skipped) console.log(`[beadcause] ${what} arrived${again} (ntfy off — clients poll for it)`);
        else console.log(`[beadcause] pushed ${what}${again}`);
      } catch (err) {
        console.error(`[beadcause] push failed for ${q.key}: ${err.message}`);
      }
      /**
       * And the same question, in a channel.
       *
       * **Here, and not a line earlier.** Everything above this point in the loop is
       * the decision about whether this question is allowed to make a noise, and the
       * `continue` above has already taken the quiet ones out — so a space that is
       * muted, or a bead the inbox filter is hiding, reaches Slack exactly as often as
       * it reaches the phone: never. A space quiet on the phone and noisy in a work
       * channel is the failure this placement rules out, and it rules it out by
       * construction rather than by lib/slack.js re-deriving a policy it would then be
       * able to get wrong.
       *
       * A catch of its own rather than sharing the one above, so a channel that has
       * been archived cannot swallow the ntfy line — the two surfaces fail
       * independently or they are not two surfaces.
       *
       * A foundation request is not posted. It is a different channel on every other
       * surface (see `pushFoundationRequest`), its options are approve and decline, and
       * a constitutional change to an agent is not something to nod through from a
       * chat window — it gets the pane on the phone that was built for it.
       */
      if (!q.foundation) {
        try {
          const slack = await postToSlack(cfg, q);
          if (slack?.ok) console.log(`[slack] posted ${q.key} to ${slack.channel} with ${slack.options} option${slack.options === 1 ? '' : 's'}`);
        } catch (err) {
          console.error(`[slack] could not post ${q.key}: ${err.message}`);
        }
      }
    }

    await checkReplies(questions.filter((q) => !fresh.includes(q)), filter, rang, account);

    // Answered somewhere other than here (an agent closed it, or `bd close` on the
    // Mac). Clients holding a notification for it need to drop it.
    for (const key of notified) {
      if (live.has(key)) continue;
      app.bus.emit({ type: 'answered', key });
      /**
       * And the Slack message for it, if there is one — the backstop for every ending
       * this daemon did not perform itself.
       *
       * `/api/respond` and `/api/dismiss` settle their own message the moment they
       * write, which is what makes the channel keep up with a tap on the phone. This is
       * the other half: a bead closed by an agent, by `bd close` on the Mac, or by a
       * second instance leaves no HTTP request here to hang a settle on, and a message
       * left with live buttons over a closed bead is the failure the whole registry
       * exists to prevent. Up to one sweep late, which is the price of being able to
       * cover an ending that happened somewhere else entirely.
       *
       * No answer text and no author: we do not know either, and `settledBlocks` says
       * "Answered" without inventing a sentence. Note it is deliberately not `await`ed
       * inside the loop — a slow Slack must not delay the sweep that is about to write
       * the state file.
       */
      settleSlack(cfg, key).catch((err) => console.error(`[slack] could not settle ${key}: ${err.message}`));
    }

    // Drop answered questions so a reopened bead notifies again.
    notified = new Set(live);
    counts = Object.fromEntries(Object.entries(counts).filter(([k]) => live.has(k)));
    pruneActivity(live);
    // A bead that has left the inbox has had its row cancelled by the `answered` above,
    // so it is no longer ringing. Pruned here rather than growing until somebody
    // notices the file. Re-read for the reason `rang` exists: the sweep is long enough
    // for the phone to have written.
    const current = loadState();
    const stillRinging = retainRinging({ ...current.ringing, ...rang }, live);
    // The quiet map is merged over disk on the same terms, and then anything in `rang`
    // is taken back out of it, so the two are disjoint per key.
    //
    // Which matters most for the case that is not a re-arrival at all: a bead that
    // arrived quietly under a narrow filter, and whose *reply* rings once the filter is
    // wide again (`checkReplies` writes into `rang` too). It is still true that the card
    // arrived quietly — but there is now a row in your shade about this bead, and a card
    // saying you were never told reads as wrong beside a notification you are holding.
    // Once this daemon has made a noise about a bead, that is the fact, and the drop is
    // what makes the card stop claiming the other one.
    const stillQuiet = retainQuiet(drop({ ...current.quiet, ...hushed }, Object.keys(rang)), live);
    saveState({
      notified: [...notified],
      commentCounts: counts,
      ringing: stillRinging,
      quiet: stillQuiet,
    });
  };

  /**
   * The poll is the advocates' clock.
   *
   * They deliberately have none of their own: "wake when a bead becomes
   * actionable" is a question this loop already asks every 30 seconds, and a second
   * timer would only mean two answers that can disagree. It runs after the pushes
   * so a slow `bd ready` across six workspaces can never delay a question reaching
   * your phone, and its failures are logged rather than thrown — an advocate that
   * cannot read its tracker must not take the notifier down with it.
   */
  /**
   * Settle every deploy whose runner has gone, and say so once.
   *
   * This runs on the first cycle, which is process start — and process start is
   * exactly where it matters, because the ordinary way a beadcause deploy ends is by
   * killing the daemon that asked for it. Whatever the runner recorded is on disk; the
   * process that comes back is the first one able to read it, and until this existed
   * nobody ever did. See lib/deploy.js.
   *
   * The announcement is marked on disk rather than remembered here, so a daemon
   * replaced mid-deploy does not re-push what its predecessor already sent — and so a
   * daemon that crashes before pushing still sends it when it comes back.
   */
  const settleDeploys = async () => {
    for (const rec of sweepDeploys()) {
      console.log(`[deploy] ${whereOf(rec)}: ${rec.id} → ${rec.status} — ${rec.error}`);
    }
    for (const rec of unannounced()) {
      /**
       * What this deploy did to the clients, or `null` — it deployed another checkout,
       * or nothing they hold moved. Two booleans on an event that is already going out
       * to every parked poll, which is the whole delivery mechanism for bc-jznr: the
       * page reloads itself off `web`, and the Android shell goes and fetches the new
       * APK off `apk`. See lib/update.js.
       *
       * On this repo the deploy has just killed the process that started it, so the
       * daemon emitting this is the *new* one, sweeping at boot — which is exactly the
       * moment the news is true, and why nothing has to survive the restart to carry it.
       */
      const effects = deployEffects(rec);
      // `key` as well as `workspace`, and the same shape `beginDeploy` emits: a board card
      // matches an event against its own key, and a record settling is the same news as one
      // starting. See `keyOf` for what an older record on disk carries.
      app.bus.emit({
        type: 'deploy',
        key: keyOf(rec),
        workspace: rec.workspace,
        repo: rec.repo || null,
        id: rec.id,
        status: rec.status,
        bead: rec.bead || null,
        // Absent rather than false where there is nothing to say: a client reading
        // `web` off an event from a daemon that predates this sees `undefined` and asks
        // /api/update, which is what it does at boot anyway.
        ...(effects ? { web: effects.web, apk: effects.apk } : {}),
      });
      // Marked before the notification, not after: a notification that did not go out is
      // a reason for one missing card, not for the same one every thirty seconds forever.
      markAnnounced(rec.id);
      if (rec.status !== 'ok') console.error(`[deploy] ${whereOf(rec)}: ${rec.id} ${rec.status} — ${rec.error || 'no reason recorded'}`);
      else console.log(`[deploy] ${whereOf(rec)}: ${rec.id} ok${rec.to ? ` at ${String(rec.to).slice(0, 8)}` : ''}`);
      /**
       * And the phone, told which of the two this was.
       *
       * Beside the `deploy` event above rather than instead of it, because the two are
       * for different readers and say different things. That one is the board's delta —
       * every parked client gets it, it carries `web`/`apk` so the page can reload
       * itself, and it fires on a record *starting* as well as settling. This one is a
       * notification: it happens once, at the end, and it is one of two classes rather
       * than a status field, because a deploy that worked is a release and a deploy
       * that did not is work being stuck, and those get different sounds and different
       * cards on the phone (bc-ka5y.15).
       */
      app.bus.emit(deployEvent(rec, { quiet: mutedNews(cfg, rec.workspace) }));
      // And the warning the last failure left in the shade, taken away by the deploy
      // that fixed it. Silent, and usually about nothing — see `deployClearEvent`.
      if (rec.status === 'ok') app.bus.emit(deployClearEvent(rec));
    }
  };

  /**
   * Close what a merge could not — the retry half of lib/owed.js.
   *
   * Ahead of the advocates and behind the pushes, and the first of those two is the
   * one that matters: a work bead that is finished but still open is precisely the
   * bead an advocate hands to a fresh session, so the close has to get there first.
   * The ordinary record clears on the poll right after the merge that made it, once
   * the card that blocked the close has closed itself.
   */
  const retryOwedCloses = async () => {
    for (const rec of await sweepOwed(app.bd, cfg.workspaces)) {
      if (rec.status === 'closed') console.log(`[pr] ${rec.workspace}: closed ${rec.id} on retry — ${rec.reason}`);
      else if (rec.status === 'gone') console.log(`[pr] ${rec.workspace}: ${rec.id} is gone; nothing left to close`);
      else if (rec.status === 'failed') console.error(`[pr] ${rec.workspace}: ${rec.id} still will not close — ${rec.detail}`);
      // Logged rather than swallowed because it is the one outcome that stops owing
      // without the bead closing: the epic stays open on purpose, and a line saying so
      // is the difference between a rule working and a close quietly going missing.
      else if (rec.status === 'refused') console.log(`[pr] ${rec.workspace}: ${rec.id} stays open — ${rec.detail}`);
    }
  };

  /**
   * Which adoptions this daemon has already said it will not apply.
   *
   * A refusal is a standing condition, not an event — `bc-4bet cannot adopt bc-d5sv:
   * already a child of bc-xl7n.1` is true on every beat until somebody arbitrates it —
   * so saying it once a cycle is thirty lines an hour that bury the one line that is
   * new. Said on the beat it first appears, and forgotten on the beat it goes away,
   * which is lib/sync.js's rule for exactly the same reason. Keyed by the sentence, so a
   * refusal whose reason changes is a new one.
   */
  const refusedAdoptions = new Set();

  /**
   * The `Adopts:` line applied — see lib/adoptsweep.js.
   *
   * **Before the advocate tick, and that is the whole of the placement argument.** The
   * tick reaches an epic's work through `bd.children` (`batchesFor` and `plansFor` in
   * lib/advocate.js), so an epic whose list has just been applied dispatches as an epic
   * with children on this beat rather than on the next one — and until bc-arj0.2 it never
   * did at all, because the adoption was prose. It takes the write lock ahead of the
   * tick, which is the cost; it is bounded by the fact that a settled graph writes
   * nothing, and after the first pass over a workspace that is every pass.
   *
   * `sweepAdoptions` lands every failure in its answer, so what reaches the cycle's catch
   * is this function's own bookkeeping — the bar `sweepFailed` is for.
   */
  const sweepAdopts = async () => {
    const out = await sweepAdoptions(app.bd, cfg.workspaces, { onLog: (line) => console.log(line) });

    const now = new Map(out.refused.map((r) => [`${r.workspace}|${describeRefusal(r)}`, r]));
    for (const [key, r] of now) {
      if (refusedAdoptions.has(key)) continue;
      console.log(`[adopts] ${r.workspace}: ${describeRefusal(r)}`);
    }
    refusedAdoptions.clear();
    for (const key of now.keys()) refusedAdoptions.add(key);
  };

  /**
   * Near-verbatim live titles, joined — see lib/dupesweep.js.
   *
   * Reads the same cached graph `sweepAdopts` just above reads, so the steady-state cost
   * of this on the poll cycle is a `Map` walk and no `bd` spawn at all — a write only for
   * a pair that clears the bar, which after the first pass over a workspace is nearly
   * always none. `sweepDuplicates` lands every failed write in its answer rather than
   * throwing, so what reaches the cycle's catch is this function's own bookkeeping, the
   * same bar `sweepAdopts` is held to.
   */
  const sweepDupes = async () => {
    await sweepDuplicates(app.bd, cfg.workspaces, { onLog: (line) => console.log(line) });
  };

  /** When the inbox was last swept for sweep cards with no record. See `sweepMerges`. */
  let recoveredCardsAt = Date.now();

  /**
   * Retention, enforced — bc-eqn1.7 and lib/agentarchive.js.
   *
   * A retention period nothing applies is a sentence in a README, and a sentence in a README
   * is what an auditor calls a policy without a control behind it. This is the control: it
   * deletes the body of every archived run past the period and appends a commit to the chain
   * saying which ones and under what rule, so a body that is gone is *disposed of* rather
   * than merely absent.
   *
   * On its own hour-long clock rather than the cycle's, and that is the honest cadence for
   * it: the retention boundary moves by a day per day, so a sweep every thirty seconds is
   * 120 `readdir`s an hour to find the same nothing. An hour is well inside any tolerance a
   * 24-month rule has, and a daemon that has been up for less than an hour has disposed of
   * nothing — which is why the first beat runs it rather than waiting one out.
   */
  let disposedAt = 0;
  const sweepAgentLogs = async () => {
    const now = Date.now();
    if (now - disposedAt < 3600 * 1000) return;
    disposedAt = now;
    const out = await disposeAgentLogs({ cfg });
    if (!out.disposed.length) return;
    console.log(
      `[agentlog] disposed of ${out.disposed.length} archived run body(ies) older than ${out.months} months` +
        `${out.chained ? '' : ` — but the disposal is not on the chain: ${out.reason || 'no checkout'}`}`
    );
  };

  /**
   * The headless Chromes and scratch directories earlier runs stranded — lib/strays.js.
   *
   * The rest of this diff stops the leak; this is what collects what has already leaked,
   * and what will still be stranded by the one signal nothing can catch. It is the only
   * sweep in the cycle that reads the process table and the only one that signals
   * something outside beadcause, so everything worth arguing about is over there: the
   * age floor, why "orphaned Chrome" is the wrong rule, and why a profile a live browser
   * is using is never removed however old it looks.
   *
   * On its own hour-long clock rather than the cycle's, for `sweepAgentLogs`'s reason and
   * one more. The boundary it sweeps to moves by an hour per hour, so a pass every thirty
   * seconds is 120 `ps` calls and 120 walks of a 13,000-entry directory an hour to find
   * the same nothing; and a `ps -A` on a Mac running twenty sessions is not free. The
   * first beat of a daemon runs it, because a daemon that has just been restarted is
   * exactly the situation in which something was left behind.
   */
  let reapedAt = 0;
  let reaping = false;
  const sweepStrays = () => {
    // A daemon booted by a suite reaps nothing — see `mayReap`. This is the one sweep in
    // the cycle whose work happens outside this process entirely, so it is the one that
    // must not run when the process is a test.
    if (reaping || !mayReap()) return;
    const olderThanMs = strayMs(cfg);
    // Zero is off, and it is the only way to switch this off — see `sweepMs`.
    if (!olderThanMs) return;
    const now = Date.now();
    if (now - reapedAt < 3600 * 1000) return;
    reapedAt = now;
    reaping = true;
    Promise.resolve()
      .then(() => reapStrays({ olderThanMs, now }))
      .then((out) => {
        const line = describeStrays(out);
        // A settled machine says nothing, which after the first pass is every pass.
        if (line) console.log(`[strays] ${line}`);
      })
      .catch((err) => {
        console.error('[strays] sweep failed:', err.message);
        sweepFailed('the stray-process sweep', err);
      })
      .finally(() => {
        reaping = false;
      });
  };

  /**
   * The pull requests the last merge put out of date — see lib/mergesweep.js.
   *
   * Four ways a merge lands and one sweep behind all four, and this is where it runs:
   * three of the doors are somewhere else entirely (a worker's own `beadcause-deliver`
   * is not even this process) and every one of them records the merge rather than
   * sweeping it, because the registry that stops two resolver windows opening on one
   * branch is in this daemon's memory and nowhere else.
   *
   * After the advocate tick and not before it, which is the only ordering that matters
   * here: the advocate is what notices a pull request merged on github.com, and it
   * records the sweep the same way the taps do. Sweeping first would leave every merge
   * Adam made from his phone waiting a whole cycle for no reason.
   *
   * `sweepConflicts` says what it did on its own — one line naming the windows it
   * opened, and only when there were any. What it cannot say is that it never ran, so
   * that is what is logged here.
   */
  const sweepMerges = async () => {
    for (const outcome of await sweepMerged(app.bd, cfg)) {
      if (outcome.card?.card) {
        // A card has just appeared in the inbox and every parked phone is still drawing
        // the list without it. `/api/poll` only rebuilds that list when the wake carried a
        // non-presence event, so a sweep that filed a card and emitted nothing would reach
        // the browser whenever something else next happened to move — hours, on a quiet
        // evening, and indistinguishable from the card not being filed at all.
        app.bus.emit({
          type: 'sweep-card',
          key: `${outcome.workspace}/${outcome.card.card}`,
          workspace: outcome.workspace,
          id: outcome.card.card,
          number: outcome.number || null,
        });
      }
      const line = describeSweepOutcome(outcome);
      if (!line) continue;
      if (outcome.status === 'swept' && (outcome.result?.error || outcome.card?.error))
        console.error(`[prsweep] ${outcome.workspace}: ${line}`);
      else console.log(`[prsweep] ${outcome.workspace}: ${line}`);
    }

    /*
     * And the other end of the same sweep — see lib/sweepcard.js.
     *
     * Immediately after the drain rather than on a clock of its own, because it is not a
     * second sweep: it is what turns the card the drain just filed into a card that tells
     * the truth twenty minutes later. Costs nothing at all when no card is open, which is
     * nearly always, and one `gh pr view` per row whose resolver has finished when one is.
     *
     * Inside the cycle's existing `the conflict sweep` guard on purpose: a failure here is
     * a failure of the same feature, and a second `sweepFailed` label would report it as a
     * separate broken sweep to somebody reading the crash card.
     */
    /*
     * And in front of it, on a clock of its own — see `recoverSweepCards`.
     *
     * A card whose record is gone is invisible to the loop below: it can never be amended
     * and can never close, and its buttons do nothing. Nothing else in the system would
     * ever mention it, so this is the only thing that finds one. Before the follow-up and
     * not after, so a card recovered on this cycle is chased on this cycle too.
     *
     * Stamped at boot for `sweptReleasesAt`'s reason: `bd human list` per workspace is a
     * process spawn each, and putting nine of them in front of a daemon's first poll is a
     * slower bring-up for a scan that is nearly always empty. A card that has been orphaned
     * for hours is not made worse by half an hour more.
     */
    if (Date.now() - recoveredCardsAt >= RECOVER_EVERY_MS) {
      recoveredCardsAt = Date.now();
      for (const o of await recoverSweepCards(app.bd, cfg)) {
        const said = describeSweepCard(o);
        if (!said) continue;
        if (o.error || o.unreadable) console.error(`[prsweep] ${o.workspace}: ${said}`);
        else console.log(`[prsweep] ${o.workspace}: ${said}`);
      }
    }

    for (const o of await followSweepCards(app.bd, cfg)) {
      // Amended or closed — two different inboxes, and a phone parked on `/api/poll` is
      // drawing the one from before both. `gone` is deliberately not one of them: nothing
      // was written to any tracker, and the workspace it names is not on the phone anyway.
      if (o.amended || o.closed) {
        app.bus.emit({
          type: 'sweep-card',
          key: `${o.workspace}/${o.card}`,
          workspace: o.workspace,
          id: o.card,
          closed: !!o.closed,
        });
      }
      const line = describeSweepCard(o);
      if (!line) continue;
      if (o.error) console.error(`[prsweep] ${o.workspace}: ${line}`);
      else console.log(`[prsweep] ${o.workspace}: ${line}`);
    }
  };

  /**
   * An epic finished — the last of the five voices, and the only one with no call site.
   *
   * Every other notification in this app happens *because* something in this process did
   * something: a question was filed, a deploy settled, a merge landed. An epic close is
   * a judgement, made in four places and only one of them here (see lib/epicdone.js), so
   * the trigger is a diff of the tracker rather than a hook — which is why this is a
   * sweep and why it has to be told which closes were taps of yours.
   *
   * On the ordinary cycle clock with no interval of its own, unlike the sync and the
   * release sweep either side of it, and that is a cost decision: `bd.graph` is one
   * `bd export` per workspace **cached for sixty seconds and shared with the inbox
   * board**, so on a daemon anybody has a phone open against this reads memory. A clock
   * of its own would only make the news later for nothing.
   *
   * `sweep` lands every failure in its outcome rather than throwing, so what reaches the
   * cycle's catch is this function's own bookkeeping — the bar `sweepFailed` is for.
   */
  const sweepEpicsDone = async () => {
    const out = await app.epicWatch.sweep(cfg.workspaces);
    // Not per workspace and not per pass: the interesting fact is that a tracker could
    // not be read at all, and a graph that failed leaves the snapshot alone rather than
    // reporting every epic in it as having vanished.
    for (const bad of out.errors) console.error(`[epic] ${bad.workspace}: could not read the tracker — ${bad.error}`);
    for (const epic of out.done) {
      console.log(`[epic] ${epic.workspace}: ${epic.id} closed — ${epic.closed} bead(s) closed under it`);
      // `app.bus`, never a bare `bus`: that name is a local of `createApp` and is not in
      // scope down here at all. bc-gdub is the bead for the four lines in this poller that
      // got it wrong, each of which is a `ReferenceError` the first time its sweep fires.
      app.bus.emit(epicDoneEvent(epic, { quiet: mutedNews(cfg, epic.workspace) }));
    }
  };

  /**
   * A root closed over open work — the other half of the same event, and the silent half.
   *
   * `sweepEpicsDone` above says an epic finished. This says what finishing it cost, which
   * until bc-xl7n.107 nothing said at all: a closed root is not a root (lib/underroot.js),
   * so every still-open bead under it leaves the ready queue and is refused 409 at every
   * launcher while continuing to read as ordinary work on every screen. Three beads reached
   * that state and were each found by an Epic Advocate running a census by hand.
   *
   * Beside the epic sweep and on the same clock for its reason — `bd.graph` is one export
   * per workspace cached for sixty seconds and shared with the inbox, so on a daemon with a
   * phone open against it this reads memory. It writes nothing at all on a healthy tracker,
   * which is most days.
   *
   * **No bus event and no card.** What it writes is a comment on a bead, which the phone
   * already draws when the bead is opened; there is no payload field for a poll to be
   * parked on, so an event would wake every phone to redraw an inbox that has not changed.
   * A *card* asking where the survivors should go is the option this bead deliberately left
   * open (its candidate 3) rather than the one it asked for.
   *
   * `sweep` lands every failure in its outcome rather than throwing, so what reaches the
   * cycle's catch is this function's own bookkeeping — the bar `sweepFailed` is for.
   */
  const sweepStranded = async () => {
    const out = await app.strandWatch.sweep(cfg.workspaces);
    for (const bad of out.errors) {
      const who = bad.id ? `${bad.workspace}: ${bad.id}` : bad.workspace;
      console.error(`[stranded] ${who} — could not say so: ${bad.error}`);
    }
    for (const bead of out.traced) {
      console.log(`[stranded] ${bead.workspace}: ${bead.id} — ${bead.root} closed above it, and it is unworkable until somebody adopts it`);
    }
    for (const root of out.roots) {
      console.log(`[stranded] ${root.workspace}: ${root.id} closed over ${root.stranded} open bead(s) — said so on each of them`);
    }
    // Never silently: a pass cut short by the cap looks exactly like a quiet one otherwise,
    // and the beads it did not reach are the ones nothing else is going to mention either.
    for (const ws of out.capped) console.log(`[stranded] ${ws}: stopped at the cap for this pass — the rest are taken on the next one`);
  };

  /**
   * How many beads has this tracker filed under nothing? — bc-xl7n.83 and
   * lib/orphancensus.js.
   *
   * Beside `sweepEpicsDone` and built the same way: `bd.graph` is one `bd export` per
   * workspace, cached for a minute and shared with the inbox's own P0 board, so running
   * this every slow-clock cycle rather than on a clock of its own costs nothing a
   * repaint was not already going to pay.
   *
   * `sweepOrphanCensus` lands every failure in its own outcome, so what reaches the
   * cycle's catch below is this function's own bookkeeping — the bar `sweepFailed` is
   * for.
   */
  const sweepOrphanCensus = async () => {
    const out = await app.orphanWatch.sweep(cfg.workspaces);
    // Same reason as `sweepEpicsDone`'s identical guard: a `bd export` that timed out
    // comes back as an empty index carrying `.error`, and the watcher itself already
    // leaves that workspace's held ids untouched rather than reporting them all cleared.
    for (const bad of out.errors) console.error(`[census] ${bad.workspace}: could not read the tracker — ${bad.error}`);
    for (const row of out.newOrphans) console.log(`[census] ${row.workspace}: ${describeOrphan(row)}`);
  };

  /**
   * Keeping a shared tracker shared, on a clock of its own — see lib/sync.js.
   *
   * Stamped at boot like `sweptReleasesAt` below, and for a different reason: not
   * because the answer keeps, but because the first thing a daemon does is read every
   * workspace, and putting two network round-trips per workspace in front of that makes
   * a slow bring-up out of something the router is waiting on. One interval later is
   * two minutes, and two minutes of a tracker being as stale as it already was when the
   * machine was off is not a cost worth paying for.
   */
  let syncedAt = Date.now();

  /**
   * A sync is quiet when it works and says so exactly twice when it does not: once on
   * the tick it broke, once on the tick it came back.
   *
   * The transitions come from lib/sync.js, which is the only thing holding the previous
   * state — without which this would be a push to the phone every two minutes for as
   * long as the wifi is down, which is the notification you learn to swipe away and
   * then keep swiping away on the day it means something else.
   *
   * Both go out as events on the in-process bus rather than as a push. `emit` is a
   * synchronous append to an array (lib/events.js), so there is nothing here to await
   * and nothing that can fail — which is the whole of why this block has no error
   * handling, and worth saying because for a while it had some and the handling was
   * the bug. What sat in this spot was an `await` on the ntfy push inside a `catch`
   * that logged `[sync] could not push: …`; under a prefix whose every other line is
   * about `bd dolt push`, a failure of the *notification* read on the screen as the
   * Dolt push failing (bc-y3qk.3). Every `[sync]` line below is about the tracker, and
   * it stays that way because nothing else at this call site can go wrong.
   *
   * **Twice per incident is the promise, and a tracker that will not settle on an
   * incident is what breaks it** (bc-y3qk.4). Nineteen transitions in one log, nine
   * recoveries against ten failures, all about one workspace whose honest state was
   * "intermittent all day": every one of those was a legitimate transition and every one
   * of them was announced. So a fourth transition inside an hour swaps the two-sentence
   * incident for a single sentence about the pattern, and then this workspace is silent
   * on the phone until it holds one way for an hour. Nothing above the phone changes —
   * the log keeps every transition, the monitor keeps every event, and the inbox banner
   * goes on saying whatever is true this minute.
   */
  const sweepSync = async () => {
    if (!syncEnabled(cfg)) return;
    const every = syncEveryMs(cfg);
    if (Date.now() - syncedAt < every) return;
    syncedAt = Date.now();

    // The ceiling each `bd dolt` call runs under, derived from `every` above rather than
    // left at bd's own two minutes — which is the same two minutes as the default
    // interval, so a tick that burned it was still running when the next was due and
    // logged the `skipped` line below (bc-y3qk.2). This is the only place that has both
    // numbers, so it is the only place that can keep them apart.
    const out = await app.syncer.sweep(cfg.workspaces, { ceiling: syncCeilingMs(cfg) });
    for (const name of out.skipped) console.log(`[sync] ${name}: still syncing from the last tick — skipped`);

    // Nothing is logged for a workspace that synced, or for one with no remote. The
    // whole list would be four lines every two minutes and the fifth — the one that
    // matters — would be the one that scrolls past.
    for (const o of out.changed) {
      // The log keeps every transition, including the ones the phone is spared. It is
      // the record — three separate passes over this bead reconstructed what the tracker
      // had been doing by counting these lines — and a record with the boring half
      // deleted is one that cannot be counted. What it gains instead is a note saying
      // the phone did not get this one, because "why was I not told" is the question a
      // damped transition invites.
      const damped = o.damped ? ' (flapping — not notified)' : '';
      const line = `[sync] ${o.workspace}: ${describeSync(o)}${damped}`;
      if (o.state === 'ok') console.log(`${line} (recovered)`);
      else console.error(line);
      // Its own event type so the monitor can colour it, and so a client keeping
      // channels apart does not have to guess from the text.
      app.bus.emit({
        type: 'sync',
        key: o.workspace,
        workspace: o.workspace,
        state: o.state,
        conflict: o.state === 'conflict',
        stuck: o.state === 'stuck',
        phase: o.phase || null,
        detail: describeSync(o),
      });
    }

    // A failure that has *become* a conflict — or become stuck — is worth saying a
    // second time even though it was already failing, because it has stopped being the
    // kind of problem that fixes itself and the first notification said it would retry.
    //
    // Exactly once per episode either way: `changed` is only true on the tick the state
    // word moves, and the word can only move into `stuck` once.
    //
    // And the third thing a tracker can be, which is neither — bc-y3qk.4. A workspace
    // that has broken and come back four times inside an hour gets one push saying so
    // and then none at all until it holds, because the alternative measured on the log
    // this was filed from is nineteen pushes about one workspace in one day, half of
    // them recoveries. `flapped` and `settled` are each true on exactly one tick, so
    // neither of these needs any state kept here.
    const flapping = out.changed.filter((o) => o.flapped);
    const broke = out.changed.filter(
      (o) =>
        !o.damped &&
        !o.flapped &&
        (o.transition === 'broke' || (o.transition === null && (o.state === 'conflict' || o.state === 'stuck')))
    );
    const recovered = out.changed.filter((o) => !o.damped && !o.flapped && o.transition === 'recovered');
    // Off `results` rather than `changed`, and that is not an oversight: settling is the
    // *absence* of a transition for an hour, so the tick it happens on is by definition
    // an ordinary one that changed nothing. Only a workspace that settled into a working
    // sync is announced — one that settles into a steady failure is already being said
    // by `broke` above, in words that fit it better.
    const settled = (out.results || []).filter((o) => o.settled && o.state === 'ok');
    // The phone's own card, on the one channel allowed to insist — and its other half.
    // A `stuck` event is a *state*, so the recovery is the same type with the same key
    // and `state: 'clear'`, which is what takes the card away. Nothing else in this
    // family is ever taken back, and nothing else needs to be.
    //
    // Flapping goes out *first* of the two that raise the card, and the order is the
    // whole reason it is written out rather than folded together: all three name the
    // same key, so on a tick where one workspace starts flapping and another goes stuck
    // the last one emitted is the one left on the screen — and of those two it has to be
    // the stuck one. Built from the outcomes rather than from `trouble()`, because the
    // tick a workspace is declared flapping on is as likely to be a *recovery* as a
    // failure, and on that tick it is not in `trouble()` at all.
    //
    // The same argument, one step further — bc-y3qk.11. `recovered` and `settled` are
    // just as capable of clobbering the card as `stuck` ever was: they are built from
    // this one workspace's own transition and know nothing about whether some *other*
    // workspace is still broken. So the clear does not get to fire off `recovered` and
    // `settled` directly — `syncCardVerdict` reads `trouble()` fresh, after the sweep,
    // and if it still names anyone the stuck card is what survives the tick, whatever
    // this workspace's own good news was.
    if (flapping.length) {
      app.bus.emit(
        syncFlappingEvent(
          flapping.map((o) => ({ workspace: o.workspace, dir: o.dir || null, flaps: o.flaps, error: o.error || null }))
        )
      );
    }
    const trouble = app.syncer.trouble();
    const clearing = [...recovered, ...settled];
    const verdict = syncCardVerdict({ broke, clearing, trouble });
    if (verdict === 'stuck') app.bus.emit(syncStuckEvent(trouble));
    else if (verdict === 'clear') app.bus.emit(syncClearEvent(clearing));
    for (const o of flapping) {
      console.error(`[sync] ${o.workspace}: flapping — ${o.flaps} transitions in the last hour, and quiet from here until it holds`);
    }
    for (const o of settled) console.log(`[sync] ${o.workspace}: has held for an hour — no longer flapping`);
  };

  /**
   * What this install publishes about itself, on a clock of its own — see
   * lib/publishsweep.js.
   *
   * The whole of bc-3muu was built as leaves with tests and no caller, so on a running
   * install `refs/beadcause/publications` did not exist and every acceptance criterion
   * beginning "every deployment publishes…" was satisfied by a function nobody called
   * (bc-keqy). This is the call.
   *
   * **On an install with the management system off this costs one `git cat-file` that
   * finds nothing.** `whenOn` in lib/management.js is the door and the sweep's whole body
   * is behind it, so an install that has never enabled the layer gets no repository, no
   * identity and no ref out of this — and `test/publishsweep.mjs` asserts the config
   * directory afterwards rather than trusting the sentence.
   *
   * `sweep` swallows every failure into an outcome of its own, including a service that
   * accepts a connection and then never speaks, so what reaches this catch is a bug in
   * this file rather than a compliance layer having a bad day — which is exactly the bar
   * `sweepFailed` is for. The interval lives inside the publisher, not here, because it
   * is the thing that also knows when it last ran.
   *
   * Quiet when there is nothing to do, and there is nothing to do on most sweeps by
   * design: a governed ref that has not moved is republished once a day, not once an
   * hour. A line per hour saying "nothing changed" is the line that trains you past the
   * one that says the chain stopped growing.
   */
  const sweepPublications = async () => {
    const out = await app.publisher?.sweep({ cfg, now: Date.now() });
    if (!out || out.verdict === 'quiet' || out.verdict === 'off') return;
    const line = `[publish] ${describePublication(out)}`;
    if (out.verdict === 'failed' || out.divergent) console.error(line);
    else console.log(line);
    // Each one separately, because they are each a record that is not being published and
    // a reader has to be able to tell which. Folded into the line above they would be a
    // clause nobody reads at the end of a sentence about a success.
    for (const s of out.skipped || []) console.error(`[publish] not published: ${s}`);
  };

  /**
   * What JIRA says is assigned to you, on a clock of its own — see lib/jirapoll.js.
   *
   * Left at zero rather than stamped at boot, which is the opposite of `syncedAt` above
   * and of `sweptReleasesAt` below, and the difference is what the first sweep costs. A
   * sync takes Dolt's write lock and a release sweep is a `gh` call per checkout; this is
   * one HTTP GET per workspace that has JIRA switched on — none at all on a machine that
   * has not configured it — and it happens in the slow half of the cycle, after the poll
   * the router is actually waiting on. Against that, a daemon that came up a minute ago
   * and is drawing an empty JIRA section is indistinguishable from one whose tickets have
   * all been closed, which is the state this whole epic exists to keep off the screen.
   *
   * `sweep` swallows every failure into a record of its own, so what reaches the cycle's
   * catch is a bug rather than a JIRA — the bar `sweepFailed` is for.
   */
  let jiraSweptAt = 0;

  const sweepJira = async () => {
    const every = jiraEveryMs(cfg);
    if (Date.now() - jiraSweptAt < every) return;
    jiraSweptAt = Date.now();

    // Optional for the same reason `app.advocates?.tick()` is: a poller can be started
    // over a hand-built app in a test, and a cycle that threw a TypeError at one would
    // file a crash bead about a fixture.
    const out = (await app.jira?.sweep(cfg, cfg.workspaces)) || { skipped: [], changed: [] };
    for (const name of out.skipped) console.log(`[jira] ${name}: still reading from the last tick — skipped`);

    // Only the workspaces whose answer actually moved, and this is not tidiness: a phone
    // parks on /api/poll until the event log advances (lib/events.js), so a ticket that
    // arrives without an event is one nobody is told about until something *else* happens
    // to move — on a quiet evening, hours. And the converse is why it is filtered: an
    // event per workspace per minute would wake every parked client every minute, and
    // each wake sweeps `bd` across every workspace to rebuild the inbox.
    for (const o of out.changed || []) {
      const detail = o.state === 'failed' ? o.error : `${o.tickets.length} assigned in JIRA`;
      console.log(`[jira] ${o.workspace}: ${detail}`);
      app.bus.emit({ type: 'jira', key: o.workspace, workspace: o.workspace, state: o.state, count: o.tickets.length, detail });
    }

    /**
     * And the bead each arriving ticket gets — one P1 epic, held, exactly once. See
     * lib/jiraepic.js.
     *
     * Here rather than on a clock of its own: what it acts on is the answer that read
     * just produced, and a second timer would only mean filing against a list that is up
     * to a minute older than the one on the screen. It is handed `out.results` rather than
     * `out.changed`, and the difference is a create that failed — a Dolt lock, a title bd
     * refused — which leaves the ticket set unmoved and so would never be retried at all.
     * The cheap path is inside the filer, not here: a tick whose every ticket already has
     * a bead makes no `bd` call of any kind.
     *
     * **No bus event.** Nothing on `/api/poll` changes when an epic is filed — a held bead
     * is out of every queue and every count, and the ticket rows are the poller's — so an
     * event here would wake every parked phone to redraw an identical inbox. What *is*
     * dropped is the endorsement queue's fifteen-second cache, because that screen is the
     * one place the new epic appears and it is fetched on its own.
     *
     * The same sweep is what follows a **rewritten JIRA summary** onto the epic's title
     * (bc-yc16), and it is handled here on both counts for the same reasons: no event,
     * because the row the phone is drawing already carries JIRA's own summary and redrew
     * when the poller saw it move, and the queue cache dropped, because the *bead's* title
     * is what that screen shows and it would otherwise answer with the old one.
     */
    // `liveResults` is the other half of cancel, and it is the half that makes it stick:
    // a ticket you cancelled is taken out of the list *before* the filer sees it, so no
    // epic is raised for it on this tick, on the next one, or after a restart. Filtering
    // only the rows on the screen would leave a cancel that hid a ticket while quietly
    // filing it a fresh bead every time the daemon came up. See lib/jiracancel.js.
    const live = liveResults(out.results);
    const epics = (await app.jiraEpics?.sweep(cfg, cfg.workspaces, live)) || {
      filed: [],
      failed: [],
      renamed: [],
    };
    for (const e of epics.filed) {
      const how = e.adopted ? `adopted ${e.id} (${e.adopted})` : `filed ${e.id}`;
      console.log(`[jira] ${e.workspace}: ${e.key} — ${how} as its epic`);
    }
    // A rename is logged in full, both halves of it, because it is the one write in this
    // sweep that changed something a person had already read — and the log is where you
    // look when a bead you remembered by name is not where you left it.
    for (const e of epics.renamed || []) {
      console.log(
        `[jira] ${e.workspace}: ${e.key} — ${e.id} renamed to follow the ticket: ` +
          `"${e.renamed.from}" → "${e.renamed.to}"`
      );
    }
    for (const e of epics.failed) console.error(`[jira] ${e.workspace || ''}: no epic for ${e.key} — ${e.error}`);
    // The endorsement queue for a rename as well as for a filing, and for the same
    // fifteen seconds: that screen is drawing the epic's title, and a queue that answers
    // out of its cache would be the one place in the app still showing the old one.
    if (epics.filed.length || epics.renamed?.length) forgetQueue();

    /**
     * And the epics whose ticket has been **resolved** out from under them — see
     * lib/jiraresolved.js.
     *
     * `out.results` and emphatically not `live`, which is the one wiring decision here
     * that could be got wrong quietly. `liveResults` takes the *cancelled* tickets out of
     * the list, and a ticket missing from this list is exactly what this sweep reads as
     * vanished — so handing it the filtered one would make every cancelled ticket look
     * resolved, buy a JIRA GET for each, and act on an epic the cancel already closed. It
     * skips cancelled keys itself, from the record, for the same reason it skips a
     * workspace whose read failed: a ticket that is *hidden* is not a ticket that is gone.
     *
     * The filer is handed in rather than re-derived because its map is the only thing
     * that knows which epic a vanished ticket had — nothing else in the daemon holds a
     * ref for a ticket the poller is no longer answering with. The settings resolver is
     * the poller's, so the by-key read reuses the ten-minute `bd config get` memo instead
     * of buying three spawns of its own.
     *
     * **No bus event, and the queue cache dropped only on a close** — the same shape as
     * the filing above, for the same two reasons. A held epic is out of every queue and
     * every count, so closing one changes nothing a phone is drawing and an event would
     * wake every parked client to redraw an identical inbox. The endorsement queue is the
     * one screen it does change, because that is where a held bead appears, and its
     * fifteen-second cache would otherwise go on offering approve on a bead that is
     * closed. A *comment* on an endorsed epic changes neither, so it drops nothing.
     */
    const resolved = (await app.jiraResolved?.sweep(cfg, cfg.workspaces, out.results, {
      filer: app.jiraEpics,
      settings: (workspace) => app.jira.settings(cfg, workspace),
    })) || { closed: [], commented: [], restored: [], failed: [] };
    for (const r of resolved.closed) {
      console.log(`[jira] ${r.workspace}: ${r.key} resolved in JIRA as ${r.resolution} — closed its epic ${r.bead}`);
    }
    // Logged as loudly as a close, because it is the case where beadcause looked at work
    // somebody had endorsed and deliberately did nothing: the log is where you find out
    // that it noticed at all.
    for (const r of resolved.commented) {
      console.log(
        `[jira] ${r.workspace}: ${r.key} resolved in JIRA as ${r.resolution} — ${r.bead} is endorsed, so it is ` +
          'left alone and told'
      );
    }
    for (const r of resolved.restored) console.log(`[jira] ${r.workspace}: ${r.key} is unresolved again — reopened ${r.bead}`);
    for (const r of resolved.failed) console.error(`[jira] ${r.workspace || ''}: could not check ${r.key || 'a vanished ticket'} — ${r.error}`);
    if (resolved.closed.length || resolved.restored.length) forgetQueue();

    /**
     * And the children under each epic — see lib/jiraingest.js.
     *
     * The join is made here rather than inside either module, because both halves of it
     * live somewhere else and each is the authority on its own half: lib/jirapoll.js
     * holds the tickets, and lib/jiraepic.js holds every ticket's epic id in a map it
     * rebuilt against the tracker. Asking the ingester to work either of those out for
     * itself would be a third guess at how the other two remember things.
     *
     * `out.results` rather than `epics.filed`, and the difference matters more here than
     * it does one line up: `filed` is only what *this tick* created or adopted, so a
     * daemon that restarted an hour after the epics were filed would never ingest any of
     * them. Every ticket whose epic is known is offered on every tick; the ingester's own
     * state is what makes that free after the first one.
     *
     * **No bus event here.** Starting to read changes nothing a phone is showing that the
     * poller's own `changed` event has not already woken it for, and the answer arrives
     * minutes later through `onSettled`.
     */
    // `live` and not `out.results`, for the reason the filer is handed it one line up: a
    // cancelled ticket's epic is still in the filer's map — nothing forgets it — so
    // ingesting off the unfiltered list would set an agent reading a ticket you turned
    // down and write its children under a bead that was closed with it.
    const pending = [];
    for (const r of live || []) {
      if (r?.state !== 'ok' || !r.tickets?.length) continue;
      const workspace = cfg.workspaces.find((w) => w.name === r.workspace);
      if (!workspace) continue;
      const known = app.jiraEpics?.knownFor(r.workspace) || new Map();
      for (const ticket of r.tickets) {
        const epic = known.get(jiraRefFor(ticket.key));
        if (epic) pending.push({ workspace, ticket, epic });
      }
    }
    if (pending.length) await app.jiraIngest?.sweep(cfg, pending);
  };

  /**
   * The release queue, on a clock of its own — and a much slower one.
   *
   * Everything else in this cycle reads a tracker or a directory. This one may reach
   * GitHub: `collectBoard` is a `gh pr list` per repo whenever its 25-second cache has
   * gone cold, and at the poll's own 30 seconds that would be a few thousand calls a
   * day to answer a question — "did anything merge?" — whose answer keeps for minutes.
   * So it runs every `release.seconds` (five, by default), and a phone reading /prs in
   * between makes the next one free: the board is the same cache either way.
   *
   * It is last in the cycle and it swallows its own failures, like the two sweeps above.
   * A `gh` that cannot reach the network, a tracker mid-write, an unreadable ledger:
   * each of those is a tick that filed nothing, and none of them is a reason for the
   * questions this poll exists to push to be a minute late.
   */
  /**
   * Stamped at boot rather than left at zero, so the **first** sweep is one interval
   * away and not in the first cycle.
   *
   * Deliberately the opposite of `settleDeploys` above, which runs at process start
   * precisely because process start is where it matters — the ordinary way a beadcause
   * deploy ends is by killing the daemon that asked for it, and the record it left is
   * unread until something comes back and reads it. Nothing here is like that: "did
   * anything merge?" is exactly as true five minutes from now, and asking it in the
   * first cycle puts a `gh auth status` and a `gh pr list` per repo — network, both of
   * them — between a daemon coming up and the poll it came up to run. The router waits
   * on that (bin/router.js), so it is not only slower, it is a slower *bring-up*.
   */
  let sweptReleasesAt = Date.now();

  /**
   * What the release queue calls when a settle window closes — the same deploy the Ship
   * button runs, with nobody pressing it.
   *
   * Deliberately the *same* call as `POST /api/release/ship`: `startDeploy`, with the
   * queue named in its reason and the oldest merge's bead on the record. So a deploy
   * nobody asked for is indistinguishable afterwards from one that was tapped, every
   * screen that already draws deploys draws this one, and the notification when it
   * settles is `settleDeploys` above through the space's own push — which means a failed
   * auto-ship reaches Adam exactly the way a failed tapped one does, with nothing new to
   * learn to notice.
   *
   * Two refusals, and both throw so lib/release.js records the attempt and does not retry:
   *
   * - **An observer never deploys.** `OBSERVING` means this daemon is watching another
   *   Mac's work, and deploying here would ship its merges into this build.
   * - **One deploy at a time**, which is `startDeploy`'s own rule; it is checked here only
   *   so the refusal can say which deploy is in the way.
   */
  const autoShip = async (ws, queue, { key = '', pin = null } = {}) => {
    if (OBSERVING) throw new Error(OBSERVING_NOTE);
    // The repo's key, not the tracker's name: lib/release.js hands it over because the queue
    // it just decided to ship belongs to one checkout of possibly forty in that workspace.
    const which = key || ws.name;
    const already = runningFor(which);
    if (already) throw new Error(`a deploy of ${which} is already running (${already.id})`);
    return beginDeploy(app.bus, cfg, which, {
      bead: queue.prs[queue.prs.length - 1]?.bead || null,
      reason: shipReason(queue),
      // The commit the settle window closed on, not the branch. A tapped Ship deliberately
      // passes none — pressing the button means whatever is owed *now* — but nobody is
      // standing here to mean that, and the batch this is for was decided a moment ago.
      pin,
    });
  };

  /**
   * How long the release sweep waits between runs — two cadences, and which one is in
   * force is a question about the ledger rather than about the clock.
   *
   * The settle window is only ever *looked at* when this sweep runs, so its resolution is
   * this interval and nothing finer: a one-minute window on a five-minute sweep is a
   * five-minute window that reports a different number, and an arrival could never be
   * seen to push a deadline out at all. See `SETTLE_SECONDS` in lib/release.js.
   *
   * So while a workspace is armed — which is a few minutes an hour, bounded by the cap —
   * it runs on `release.armedSeconds`, and the rest of the time on `release.seconds` as
   * it always has. That is the whole of the answer to why the slow one is slow
   * (lib/config.js: a `gh pr list` per repo when nobody has looked at the board
   * recently): the expensive cadence is paid for only during the window it is for.
   *
   * The ledger read is why this is not simply a variable — it is a small JSON file this
   * process usually wrote itself, and the alternative is the sweep keeping its own copy
   * of what is armed, which is state that can disagree with the file that decides.
   */
  const slowEvery = () => Math.max(60, Number(cfg.release?.seconds) || 300) * 1000;

  const sweepEvery = () => {
    const slow = slowEvery();
    if (!anyArmed(loadLedger() || {})) return slow;
    // Never slower than the ordinary cadence, and never faster than the tick that calls
    // this — a sweep asked for more often than the cycle runs is just the cycle.
    return Math.min(slow, Math.max(15, Number(cfg.release?.armedSeconds) || 30) * 1000);
  };

  /**
   * What the sweep says about *itself* — see `sweepVoice` in lib/release.js, where the
   * three lines it can produce are argued for. Held out here rather than inside
   * `sweepRelease` because it is the only state in this cycle that spans sweeps.
   */
  const releaseVoice = sweepVoice();

  const sweepRelease = async () => {
    const every = sweepEvery();
    if (Date.now() - sweptReleasesAt < every) return;
    sweptReleasesAt = Date.now();
    const board = await collectBoard(app.bd, cfg);
    if (board.unavailable) {
      // This used to be a bare `return`, and bc-68ou.8 is what it cost: a board that
      // would not collect for three hours is three hours in which no merge deploys
      // itself, and the log said exactly what a quiet morning says. On stderr because
      // it is the reason a thing that was expected to happen did not.
      for (const line of releaseVoice.skipped(board.unavailable)) console.error(`[release] ${line}`);
      return;
    }
    const out = await sweepReleases(app.bd, cfg, board, {
      owner: ownerName(cfg),
      deploys: listDeploys({ limit: 200 }),
      ship: autoShip,
      // What the sweep asks when a ship bead names a pull request the board is not
      // carrying — the board is trimmed to twelve settled rows per repo for a screen, and
      // before bc-xl7n.108 that trim decided which ship beads could ever close. Injected
      // rather than imported because lib/prboard.js imports lib/release.js, and passed
      // only here: no test asks GitHub about anything by accident.
      lookup: offBoardRows,
    });
    // Before the outcome lines below, because it is the frame they are read in: six beads
    // filed at once after a three-hour gap is a catch-up, and six filed on the ordinary
    // cadence is a busy morning, and nothing in the lines themselves tells those apart.
    // `slowEvery()` and not `every`: while a settle window is armed the sweep runs every
    // thirty seconds, and measuring a gap that was accrued on the ordinary cadence
    // against the fast one would call every arming late.
    for (const line of releaseVoice.ran({ since: out.since, every: slowEvery() })) console.log(`[release] ${line}`);
    for (const w of out.watermarked) {
      console.log(
        `[release] ${w.where || w.workspace}: watching from now — ${w.merged} pull request${w.merged === 1 ? '' : 's'} already merged, none filed`
      );
    }
    // `under <root>` where the pull request named a bead with a root over it, and nothing
    // where it did not — the one thing about a filed ship bead you cannot read off the
    // bead's own title, and the thing bc-arj0.5 changed.
    for (const f of out.filed) {
      console.log(
        `[release] ${f.where || f.workspace}: filed ${f.bead}${f.parent ? ` under ${f.parent}` : ''} for #${f.number} — merged, not live`
      );
    }
    for (const c of out.closed) {
      console.log(
        `[release] ${c.where || c.workspace}: closed ${c.bead} — #${c.number} is live${
          c.offBoard ? ', found by walking the open ship beads rather than the board' : ''
        }`
      );
    }
    // The work bead, not the ship bead — the line that says a merge going live is now a
    // fact on the bead somebody wrote the code for, and `bd list --label shipped` will
    // say so tomorrow when this has scrolled past.
    for (const m of out.marked) {
      console.log(
        `[release] ${m.where || m.workspace}: #${m.number} is live — labelled ${m.beads.join(', ')} \`shipped\``
      );
    }
    for (const a of out.armed) {
      console.log(
        `[release] ${a.where || a.workspace}: auto-ship armed for #${a.numbers.join(', #')} — one deploy when the settle window closes`
      );
    }
    // The window moving is worth a line of its own: a deploy that was a minute away and
    // is now a minute away again looks, from outside, exactly like a deploy that is late.
    for (const e of out.extended) {
      console.log(
        `[release] ${e.where || e.workspace}: settle window extended by #${e.numbers.join(', #')} — ` +
          `deploying when the merges stop, and no later than ${new Date(e.until).toLocaleTimeString()}`
      );
    }
    for (const s of out.shipped) {
      console.log(
        `[release] ${s.where || s.workspace}: auto-shipping ${s.count} merged pull request${s.count === 1 ? '' : 's'}${
          // The commit, short, because the question after a surprising deploy is which
          // tree went out — and the answer is no longer "whatever was there when it ran".
          s.pin ? ` at ${s.pin.slice(0, 8)}` : ''
        } — ${s.deploy || 'no record'} (${
          // Which clock ran out. A batch that left at the ceiling was still being merged
          // into when it went, so the merges that follow it are expected rather than a
          // sign that something was dropped.
          s.capped ? `still merging at the ${Math.round(s.waited / 60000)}-minute cap; ${s.why}` : s.why
        })`
      );
    }
    for (const s of out.skipped) console.log(`[release] ${s}`);
    if (out.error) console.error(`[release] ${out.error}`);
  };

  /**
   * The cheap half of the cycle — see lib/detect.js.
   *
   * One ~150-byte read per workspace, answering *did anything write to this tracker?*
   * without spawning anything. It is what lets the sweep below run on a five-second
   * clock without the sweep's cost running on one.
   */
  const detector = createChangeDetector();

  /** How long a full cycle's worth of sweeps waits between runs — the old clock. */
  const cycleMs = Math.max(5, cfg.pollSeconds || 30) * 1000;

  /**
   * When the inbox was last swept, and when the slow sweeps last ran.
   *
   * **Two clocks and not one**, because they now run at different rates and a shared
   * timestamp would couple them: a tracker write at t+5 would move the questions sweep
   * *and* push the advocate tick, the release queue and the tracker sync five seconds
   * further out, so a busy afternoon would starve the very sweeps that are supposed to
   * be on a fixed budget. Zero rather than `Date.now()` so the first beat — the
   * `beat()` called directly below the interval — does everything, exactly as it
   * always has.
   */
  let sweptAt = 0;
  let cycledAt = 0;

  /**
   * Whether a beat is still running, and how many beats have been dropped on the floor
   * because of it.
   *
   * `setInterval` does not await an async callback: at thirty seconds this was a
   * theoretical overlap, and at five it is an ordinary Tuesday — `bd list` over 500
   * beads has been measured at 28 seconds under the load twenty agent sessions and a
   * full `npm test` put on this laptop. Without this, a slow sweep would have a second
   * sweep started on top of it every five seconds until the machine gave up, each one
   * queueing behind the same Dolt lock that made the first one slow.
   *
   * The skipped beats are counted and reported once, when the long beat finally ends,
   * rather than logged as they happen: the interesting fact is "that cycle ran long",
   * and one line saying so beats five saying nothing.
   */
  let running = false;
  let skipped = 0;

  /**
   * Whether a warm pass is out, and why the pass is not awaited by the beat.
   *
   * `warmKeys` reads the same trackers the sweeps above do, and on a cold key it reads
   * them *fully* — the console's four `bd` calls per workspace, the endorsement queue's
   * forty `bd show`s. Awaiting that inside `cycle` would put it in front of the next
   * beat's `tick`, because `beat` refuses to overlap itself, and `tick` is the thing
   * that puts a question on a phone. A screen nobody is looking at must never be able
   * to delay one somebody is waiting on, so the pass runs beside the cycle rather than
   * inside it.
   *
   * Which leaves two things this has to do that an `await` would have done for free.
   * The guard is the first: without it a pass that takes longer than a beat would have
   * a second pass started on top of it every five seconds, each queueing behind the
   * same Dolt lock — the identical failure `running` exists to stop one level up. The
   * `catch` is the second, and it is not tidiness: an unhandled rejection out of a
   * detached promise kills the daemon, and `warming` would be left true, which is how a
   * warmer silently stops warming for the life of the process.
   *
   * The log line only ever appears when something was actually filled. A warmer that
   * announced each quiet pass would be the noisiest line in the log and the least
   * informative — the interesting fact is that a key *was* cold, not that none were.
   */
  let warming = false;

  const warmSweep = (moved, now) => {
    if (warming || typeof app.warmKeys !== 'function') return;
    warming = true;
    Promise.resolve()
      .then(() => app.warmKeys({ moved, floorMs: cycleMs, now }))
      .then((filled) => {
        if (filled?.length) console.log(`[warm] filled ${filled.join(', ')}`);
      })
      .catch((err) => {
        console.error('[warm] pass failed:', err.message);
        sweepFailed('the cache warmer', err);
      })
      .finally(() => {
        warming = false;
      });
  };

  const cycle = async () => {
    const now = Date.now();

    // Sampled before anything else and on every beat, so the baseline is always from
    // *before* the sweep that is about to read bd. A write landing mid-sweep is then
    // seen on the next beat rather than missed — the safe direction, and the reason
    // this is not folded into the `if` below.
    const moved = detector.moved(cfg.workspaces);

    // The backstop is what covers everything the manifest cannot see: a workspace with
    // no embedded Dolt, a card set aside whose gate has cleared, an `activity` file the
    // phone rewrote. It is the old cadence exactly, so the worst this whole mechanism
    // can do is nothing.
    if (moved.length || now - sweptAt >= cycleMs) {
      if (moved.length) console.log(`[beadcause] ${moved.join(', ')} changed — sweeping now`);
      sweptAt = now;
      await tick();
      // And the same beat fills the keys behind the screens that notification sends
      // somebody to — bc-1kwl.4. Not awaited, deliberately: see `warmSweep`.
      //
      // Inside this branch rather than on every beat, which is a cost decision and not
      // a tidiness one. The fast clock beats every five seconds and almost always finds
      // nothing; a warm pass on each of those would still be reading `state.json` off
      // the disk to work out which workspaces the endorsement queue's key is scoped to,
      // six times a minute, to peek a key that is already filled. Here it runs when a
      // tracker moved or when the backstop came round, which is exactly the cadence the
      // gate is written against — and the first beat of a daemon is one of them, so a
      // restart still warms without waiting to be asked.
      warmSweep(moved, now);
    }

    // Everything below is on the slow clock. None of it is what a phone is waiting on:
    // the advocate tick opens sessions, the release queue asks GitHub, the sync takes
    // Dolt's write lock. Running any of them six times as often would be spending the
    // whole of the budget this bead exists to protect.
    if (now - cycledAt < cycleMs) return;
    cycledAt = now;

    try {
      // Before the advocates and after the pushes, for the same reason the advocates
      // are where they are: this reads a directory and may send one notification, and
      // nothing about it should be able to delay a question reaching the phone.
      await settleDeploys();
    } catch (err) {
      console.error('[deploy] sweep failed:', err.message);
      sweepFailed('the deploy sweep', err);
    }
    try {
      await retryOwedCloses();
    } catch (err) {
      console.error('[pr] owed-close sweep failed:', err.message);
      sweepFailed('the owed-close sweep', err);
    }
    try {
      // Before the tick, so an epic whose `Adopts:` list has just become edges dispatches
      // as an epic with children on this beat rather than the next — see `sweepAdopts`.
      await sweepAdopts();
    } catch (err) {
      console.error('[adopts] sweep failed:', err.message);
      sweepFailed('the adoption sweep', err);
    }
    try {
      // Reads the graph `sweepAdopts` just refreshed if it wrote — see `sweepDupes`.
      await sweepDupes();
    } catch (err) {
      console.error('[dupes] sweep failed:', err.message);
      sweepFailed('the duplicate sweep', err);
    }
    try {
      /**
       * Before the advocate tick, and the ordering is load-bearing — bc-r941.3.
       *
       * The queue closes work beads. The tick's survey is what decides which beads are
       * ready and whether to open a window on one, and a survey run a beat before the
       * close sees work that has just merged as work that is still waiting. That is not
       * a cosmetic lag: it is the advocate opening a second session on a bead whose pull
       * request landed thirty seconds ago, which is the exact duplication `landed(a)`
       * inside the tick already exists to prevent for merges made on github.com.
       *
       * Its own guard rather than sharing the tick's, because they fail for different
       * reasons and a queue that cannot reach GitHub must not read as an advocate that
       * cannot open windows.
       */
      await app.runMergeQueue?.();
    } catch (err) {
      console.error('[merge-queue] sweep failed:', err.message);
      sweepFailed('the merge queue', err);
    }
    try {
      await app.advocates?.tick();
    } catch (err) {
      console.error('[advocate] tick failed:', err.message);
      sweepFailed('the advocate tick', err);
    }
    try {
      // After the tick, because the tick is what finds out about a merge on github.com
      // and records one of these. `sweepMerged` swallows every failure a sweep can have
      // into an outcome of its own, so what reaches this catch is a bug by construction
      // — the bar `sweepFailed` is for.
      await sweepMerges();
    } catch (err) {
      console.error('[prsweep] sweep failed:', err.message);
      sweepFailed('the conflict sweep', err);
    }
    try {
      await sweepRelease();
    } catch (err) {
      console.error('[release] sweep failed:', err.message);
      sweepFailed('the release sweep', err);
    }
    try {
      // Late in the slow half, because nothing waits on it: an epic that finished is
      // exactly as finished a minute from now, and this is the one sweep here whose
      // whole output is a sound. It reads a cache rather than the tracker, so the
      // position costs nothing either way — see `sweepEpicsDone`.
      await sweepEpicsDone();
    } catch (err) {
      console.error('[epic] sweep failed:', err.message);
      sweepFailed('the epic-done sweep', err);
    }
    try {
      // Immediately after the epic sweep, because it is the same event read the other way
      // round and it reads the same cached graph — see `sweepStranded`. Late in the slow
      // half for the same reason as its neighbour: nothing waits on it, and a bead that
      // went unworkable is exactly as unworkable a minute from now.
      await sweepStranded();
    } catch (err) {
      console.error('[stranded] sweep failed:', err.message);
      sweepFailed('the stranded-bead sweep', err);
    }
    try {
      // Beside `sweepEpicsDone` and for the same reason — it reads the same cache and
      // nothing waits on it, so the position costs nothing either way.
      await sweepOrphanCensus();
    } catch (err) {
      console.error('[census] sweep failed:', err.message);
      sweepFailed('the orphan-census sweep', err);
    }
    try {
      // Anywhere in the slow half would do — nothing waits on it and it usually does
      // nothing at all. Here rather than first, because a disposal is the one sweep whose
      // work is *deleting*, and it should never be what a beat spends its first second on
      // when a question is waiting behind it.
      await sweepAgentLogs();
    } catch (err) {
      console.error('[agentlog] disposal sweep failed:', err.message);
      sweepFailed('the agent-log disposal sweep', err);
    }
    // Beside the other disposal and for its reason — nothing waits on it and it usually
    // does nothing at all — but **not awaited**, which the one above is. Its work is a
    // `ps` and up to two thousand recursive removals, so a pass can run for tens of
    // seconds; awaited, that is tens of seconds in front of the next beat's `tick`, and
    // `tick` is the thing that puts a question on a phone. That is not a theory either:
    // awaiting it was what took `test/filter.mjs` red. It carries its own overlap guard
    // and its own `catch` for the same two reasons `warmSweep` does — a second pass
    // started on top of a slow one, and an unhandled rejection out of a detached promise
    // killing the daemon.
    sweepStrays();
    try {
      /**
       * bc-dgx7.7's backstop. `auditor.noteArchive` only ever fires from the advocate's
       * archive loop, which is the one thing that knows which checkout a session just
       * landed in — a checkout that finishes its sessions and then goes quiet gets no
       * further look, because nothing else in the daemon ends a session in it. This is
       * that other look: every checkout of every workspace, asked whether its oldest
       * unread archive is old enough to run anyway.
       *
       * Not awaited past the dispatch, and not because it might throw — it never does — but
       * because a run that actually starts can take up to fifteen minutes, and this runs in
       * the same slow half as the advocate tick and the merge queue. `sweepStale` returns
       * as soon as it has fired whichever checkout's `audit()` call reaches the `running`
       * latch first; every other checkout's call resolves to a cheap refusal behind it. The
       * `try` here is for `sweepStale` itself, not for what it starts — a malformed
       * `cfg.workspaces` throwing synchronously is the only way this catch is ever reached.
       */
      app.auditor?.sweepStale?.();
    } catch (err) {
      console.error('[audit] sweep failed:', err.message);
      sweepFailed('the session audit sweep', err);
    }
    try {
      // After the sweeps that decide what is on the phone and before the sync that takes
      // the write lock: this is network-bound and nothing else in the cycle waits on it,
      // but a JIRA site that has gone slow must not be what delays a `bd dolt pull`.
      await sweepJira();
    } catch (err) {
      console.error('[jira] sweep failed:', err.message);
      sweepFailed('the JIRA poll', err);
    }
    try {
      // Second to last, and the ordering is the argument the others make: this is the only
      // sweep that goes to the network *and* takes Dolt's write lock, so nothing that a
      // phone is waiting on should be behind it. `syncOnce` swallows its own failures into
      // an outcome, so what reaches this catch is a bug rather than a tracker — which is
      // exactly what `sweepFailed` is the bar for.
      await sweepSync();
    } catch (err) {
      console.error('[sync] sweep failed:', err.message);
      sweepFailed('the tracker sync', err);
    }
    try {
      // Genuinely last. Nothing waits on it, it runs on an hourly clock of its own, and it
      // is the one sweep that both writes evidence and may reach a network with a
      // thirty-second deadline behind it — so it goes after even the tracker sync, which
      // is the sweep every other one here is ordered in front of.
      await sweepPublications();
    } catch (err) {
      console.error('[publish] sweep failed:', err.message);
      sweepFailed('the publication sweep', err);
    }
  };

  /**
   * One beat of the fast clock, with the overlap guard around it.
   *
   * The guard swallows nothing: `cycle` catches its own sweeps and `tick` catches its
   * own read, so what a rejection here would mean is a bug in the cycle's own
   * bookkeeping. It is caught anyway, because an unhandled rejection out of a timer
   * kills the daemon, and `running` would be left true — which is the one failure that
   * turns a poller into a poller that has silently stopped.
   */
  const beat = async () => {
    if (running) {
      skipped += 1;
      return;
    }
    running = true;
    try {
      await cycle();
    } catch (err) {
      console.error('[beadcause] cycle failed:', err.message);
      sweepFailed('the cycle', err);
    } finally {
      running = false;
      if (skipped) {
        console.log(`[beadcause] the last cycle ran long — ${skipped} beat(s) skipped while it finished`);
        skipped = 0;
      }
    }
  };

  beat();
  return setInterval(beat, detectIntervalMs(cfg));
}

/**
 * The servers this process's own `listen()` bound, kept so `/api/tls` can say what is
 * on the socket.
 *
 * `null` until something has been bound. Read rather than snapshotted, because what is
 * on the socket changes without a rebind: `renewOnce` swaps a renewed certificate onto
 * it and `acquireOnce` puts a first one there, so a value copied at boot would go stale
 * in exactly the window somebody is looking at this screen. It exists for `npm run
 * start:bare`, where this process *is* what owns the port and so is the only thing that
 * can say; behind the router that answer comes from the router's own state instead. Two
 * sources, one question, and the screen takes whichever can answer it.
 */
let boundServers = null;

/**
 * What is on this process's own tailnet socket right now, in `/api/tls`'s shape.
 *
 * `checkedAt` is carried here too, and it is not a guess: under `npm run start:bare` —
 * the only configuration in which this function answers at all — bin/beadcause.js runs
 * `startRenewal` over these very server objects, and `startRenewal` stamps
 * `tlsCheckedAt` on each of them every tick. So the loop this timestamp is about is
 * running in this process, and the stamp is read off the same object as the material
 * beside it rather than from a second source that could disagree with it. Absent only
 * before the first tick, where `null` is the honest answer and the screen says nothing.
 */
function ownTls() {
  if (!boundServers) return null;
  const server = boundServers.filter(isSecure).find((s) => s.tlsMaterial);
  const material = server?.tlsMaterial;
  if (!material) return { tls: false, name: null };
  const left = daysLeftOf(material.cert);
  return {
    tls: true,
    name: material.name,
    daysLeft: left === null ? null : Math.round(left * 10) / 10,
    checkedAt: server.tlsCheckedAt || null,
  };
}

/**
 * What is on the socket the phone actually connects to, or `null` if nothing here can
 * say.
 *
 * The router first, because in the installed configuration the router *is* the socket
 * — and it reports what `renewOnce` last swapped onto it, so a certificate replaced
 * without a restart is reflected rather than whatever was true at boot. A router too
 * old to carry the field answers `undefined`, which falls through to the same `null`
 * as no router at all: a screen saying "restart to serve HTTPS" on the strength of a
 * guess would be worse than one that says nothing.
 */
async function liveTls(cfg) {
  const router = await routerHealth(cfg).catch(() => null);
  if (router && router.certificate !== undefined) {
    return router.certificate ? { tls: true, ...router.certificate } : { tls: false, name: null };
  }
  return ownTls();
}

/**
 * Bind loopback, and the tailnet address when there is one — never `0.0.0.0`.
 *
 * The tailnet address gets TLS 1.2-or-better with a real certificate for this
 * machine's MagicDNS name; loopback stays plain HTTP. Both halves of that are
 * deliberate and lib/tls.js says why. Behind the router this is loopback only —
 * bin/beadcause.js passes `host: '127.0.0.1'` — so an internal backend is never the
 * thing terminating TLS, and the router's proxy hop stays the plain loopback call it
 * has always been.
 *
 * What comes back is the request-serving servers, because that is what the terminal
 * WebSocket attaches its `upgrade` handler to. A TLS one carries the `net.Server`
 * that owns the port as `.front`, so a caller shutting down closes both — use
 * `closeServer`. A tailnet address that wants a certificate and has not got one yet
 * hands back two: the HTTPS server that is waiting for one and the plain HTTP server
 * answering the port meanwhile. `tailnetServer` says why they share a socket.
 *
 * **A tailnet address that is not on this Mac yet is deferred, not lost.** Tailscale is
 * often still connecting when launchd starts this at login, and the address it will give
 * this machine is on no interface at that moment — so the bind fails, loopback binds, and
 * the process used to carry on serving nothing the phone could reach. It now watches for
 * the address and binds it when it appears (`deferTailnet`, and lib/tailnet.js). The
 * servers that come up late are pushed onto the array this returns *and* handed to
 * `onLateBind`, because a socket the caller has not seen is a socket with no terminal
 * upgrade on it and no certificate loop around it — bin/beadcause.js re-runs both.
 *
 * `watchEveryMs` is how often that watcher looks, and it is here for one reason that is
 * not tuning: a suite driving the deferral cannot wait out lib/tailnet.js's five-second
 * default on every case. The same seam `startRenewal` has, for the same reason.
 */
export function listen(cfg, handler, { onLateBind = null, watchEveryMs = undefined } = {}) {
  const hosts = ['127.0.0.1'];
  if (cfg.host && cfg.host !== '127.0.0.1') hosts.push(cfg.host);

  // Pushed into rather than built by a `flatMap`, because a deferred tailnet address
  // joins it minutes later — and this is the same array `boundServers` points at, the
  // same one bin/beadcause.js closes on SIGTERM and the same one it hands to
  // `startRenewal`. A late socket has to arrive in *this* object, not in a copy of it.
  const servers = [];

  let bound = 0;
  let failed = 0;

  /**
   * Bind one address, and hand back the request-serving servers that came up on it.
   *
   * A function of its own because the tailnet address may have to be bound twice: once
   * at startup, where it can fail because Tailscale is not up yet, and once when it
   * appears. `certificate(cfg)` is therefore asked **per bind rather than once per
   * `listen`** — by the time a deferred address arrives, `startRenewal` may have fetched
   * the very certificate this socket should come up carrying, and a `material` captured
   * at startup would leave it on plain http until the next restart. Loopback never asks:
   * it is never TLS, and a loopback-only listener — every test, and every backend behind
   * the router — must not shell out to `tailscale` to find that out.
   */
  const bindHost = (host, { onBound = null, onError }) => {
    const onTailnet = host !== '127.0.0.1';
    const material = onTailnet ? certificate(cfg) : null;
    // Wanted, which is not the same as held: without a certificate the tailnet address is
    // still bound behind the sniffing front, serving plain http until `startRenewal`
    // manages to get one. `tls.enabled: false` is the case where it is not wanted at all.
    const wanted = onTailnet && tlsEnabled(cfg);
    const { server, front, plain } =
      wanted ? tailnetServer(material, handler) : { server: http.createServer(handler), front: null, plain: null };
    // The front owns the port when there is one, so it is the one that fails to bind
    // and the one that has to be closed. `tailnetServer` has already hung it on both
    // servers as `.front` for `closeServer` to find.
    const listener = front || server;
    listener.on('error', (err) => {
      console.error(`[beadcause] listen ${host}:${cfg.port} — ${err.message}`);
      onError(err);
    });
    listener.listen(cfg.port, host, () => {
      bound++;
      onBound?.();
      // What was bound, not what was asked for. They are the same number for the
      // daemon and the router, which always name a port — but suites pass `port: 0`
      // and let the kernel choose (test/helpers/net.mjs says why), and "listening on
      // :0" is a lie in the one place someone reads this log to find out where the
      // server went.
      const port = listener.address()?.port ?? cfg.port;
      if (material && onTailnet) console.log(`[beadcause] listening on https://${material.name}:${port} (${host}, ${MIN_VERSION} floor)`);
      else if (plain) console.log(`[beadcause] listening on http://${host}:${port} — no certificate yet; https if one arrives`);
      else console.log(`[beadcause] listening on http://${host}:${port}`);
    });
    return [server, plain].filter(Boolean);
  };

  /** Whether a deferral is already outstanding, so two failures start one watcher. */
  let tailnetDeferred = false;

  /**
   * The tailnet address is not on this Mac. Say which of the causes it is — and then
   * wait for it and bind it, where this used to say "restart" and leave it there.
   *
   * bc-b4fs gave bin/router.js exactly this and left `npm run start:bare` with the
   * diagnosis alone: a daemon started before Tailscale finished connecting served
   * loopback forever, reported itself healthy, and was curable only by noticing and
   * starting it again. That is the common way in — launchd starts this at login, seconds
   * before Tailscale connects — so the unattended half matters here as much as it does
   * behind the router, and closing the gap between the two bind loops is bc-b4fs.1.
   *
   * Binding the socket is only half of what has to happen, and the other half is not
   * this file's: under `start:bare` the sockets are threaded through
   * `attachTerminalSocket` and `startRenewal` by bin/beadcause.js, and a socket neither
   * of them has seen is one with no terminal on it and no certificate loop around it.
   * So `onLateBind` is handed the new servers and the caller re-arms both. A caller that
   * passes no hook still gets the address bound and served — with a certificate, if one
   * could be fetched at that moment — and simply gets neither of those two back.
   */
  const deferTailnet = () => {
    if (tailnetDeferred) return;
    tailnetDeferred = true;
    console.error(`[beadcause] tailnet     ${tailnetLine(cfg.host)}`);
    watchForAddress(cfg.host, () => {
      tailnetDeferred = false;
      console.log(`[beadcause] tailnet     ${cfg.host} is on this Mac now — binding it without a restart`);
      let late = null;
      late = bindHost(cfg.host, {
        // On the bind actually succeeding, and not a moment before it. The array these
        // join is what `startRenewal` filters and what `shutdown` closes, so a socket
        // that never came up has no business in it — and an address that flaps would
        // otherwise leave a dead pair behind on every attempt.
        onBound: () => {
          servers.push(...late);
          // Loosely, and after the array already has the sockets in it: a caller whose
          // re-arming throws must not take down a daemon that is otherwise serving on
          // the address it has just got back.
          try {
            onLateBind?.(late);
          } catch (err) {
            console.error(`[beadcause] tailnet     bound ${cfg.host}, but re-arming the daemon around it failed — ${err.message}`);
          }
        },
        // Nothing to exit over here whatever happens: loopback is already serving, and
        // an address that has gone away again between the watcher seeing it and this
        // bind is simply deferred a second time.
        onError: (err) => {
          late?.forEach(closeServer);
          if (err.code !== 'EADDRNOTAVAIL') return;
          // After a wait, and never straight away. `watchForAddress` fires immediately
          // for an address the interface list already claims — and the list claiming one
          // the kernel then refuses to bind is precisely the state this branch is in, so
          // re-arming synchronously is a hot loop rather than a retry: defer, fire, fail,
          // defer, as fast as the event loop will go, for as long as the two disagree.
          // One interval of quiet makes it a retry again.
          setTimeout(deferTailnet, watchEveryMs ?? WATCH_EVERY_MS).unref?.();
        },
      });
    }, { intervalMs: watchEveryMs });
  };

  for (const host of hosts) {
    // Kept so the error path can take them back out again — see the EADDRNOTAVAIL branch.
    let born = null;
    born = bindHost(host, {
      onError: (err) => {
        // Bind failure on every address means another instance owns the port. Die,
        // rather than lingering as a listener-less process whose poller still fires
        // pushes — launchd's KeepAlive can't see that, and two pollers double-notify.
        //
        // `PORT_TAKEN_EXIT` and not 1, because this process is usually a *backend* and
        // its parent router cannot read this log: stdio is inherited, so both of them
        // write to the same launchd file and neither reads it. The exit code is the only
        // sentence the router gets, and "the port was taken" has to be distinguishable
        // from "the build is broken" — the router retries the first on a fresh port and
        // condemns the build for the second. lib/startup.js says why that difference is
        // the bead.
        if (++failed === hosts.length && bound === 0) {
          console.error('[beadcause] no address could be bound — exiting');
          process.exit(PORT_TAKEN_EXIT);
        }
        // A tailnet address that is not on this Mac is not the failure above — loopback
        // has bound, something is being served, and there is nothing to exit over. It is
        // also not nothing, which is what it used to be: bc-b4fs is a morning spent on a
        // daemon that reported itself healthy while the phone could not reach it, and the
        // only trace was the `EADDRNOTAVAIL` line above.
        if (host === '127.0.0.1' || err.code !== 'EADDRNOTAVAIL') return;
        // Out of the array again, because a server that never bound is not a server this
        // process is serving on — and this array is read as though it were. `ownTls`
        // answers `/api/tls` off it, and would otherwise report https on a socket
        // nothing can connect to; `startRenewal` takes the first one carrying material
        // and would renew onto the dead one rather than the live one the deferral is
        // about to bind. Both used to be true, quietly, for as long as Tailscale was
        // down. Nothing is lost by dropping them: the deferral builds a fresh pair, with
        // a certificate asked for again at the moment it binds.
        for (const s of born || []) {
          const at = servers.indexOf(s);
          if (at >= 0) servers.splice(at, 1);
          closeServer(s);
        }
        deferTailnet();
      },
    });
    servers.push(...born);
  }

  boundServers = servers;
  return servers;
}
