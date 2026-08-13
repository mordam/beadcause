import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bd } from './bd.js';
import { endorse } from './endorse.js';
import { release } from './superseded.js';
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
import { isP0, ownedByMe, ownerUpdate, ownersOn } from './ownership.js';
import { ancestorsOf, underAnyOf } from './ancestry.js';
import { hasP0Above, p0RootsOf } from './underp0.js';
import { homeIn } from './homing.js';
import { waitingOn } from './epicadvocate.js';
import { formatPlan, readPlan } from './plan.js';
import { endorsementQueue, forget as forgetQueue } from './endorsequeue.js';
import { say, threadOf, DISCUSS_MAX } from './discuss.js';
import { toQuestion, optionById } from './decision.js';
import { parseGraph, enrichGraph, movedSince } from './graph.js';
import { collectWork, shortActor } from './work.js';
import { liveSessions } from './claude.js';
import { tailTranscript } from './transcript.js';
import {
  pushQuestion,
  pushReply,
  pushFoundationRequest,
  pushFoundationReply,
  pushDeploy,
  pushSyncTrouble,
  pushSyncedAgain,
} from './notify.js';
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
  openEpicAdvocateSession,
  openSession,
  openShipSession,
  resolveSessionDir,
  sessionReach,
  terminalPrompt,
} from './session.js';
import { multiRepo, unitFor, whereLanded } from './repos.js';
import { bringUp, isHeld, putBack, touch as touchFocus } from './focus.js';
import { authorOf } from './prauthor.js';
import { collectBoard, forgetBoard, landLocally, pickCard } from './prboard.js';
import { decorateBoard, loadLedger, releaseFor, shipReason, sweepReleases } from './release.js';
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
import { ledger as beadLedger, parseQuery as parseLedgerQuery } from './history.js';
import { dispatchReply, agentBusyOn, busyAgents } from './dispatch.js';
import { createAdvocates, PROPOSAL_LABEL } from './advocate.js';
import { createAdmin } from './admin.js';
import { deployFor, deployHint, deployable, startDeploy, listDeploys, showDeploy, briefDeploy, deployLog, keyOf, runningFor, whereOf, reportingQuiet, sweepDeploys, unannounced, markAnnounced } from './deploy.js';
import { parseProposal, isApproval, parseApproval, applyEdits, dupeNote } from './proposal.js';
import { annotateDuplicates, findDuplicate, liveCandidates } from './dupe.js';
import { resolveAmendment, AMENDMENT_LABEL } from './amendment.js';
import { deliveryAction, parseDelivery, cardsForDelivery, slugOf, DELIVERY_LABEL } from './delivery.js';
import { oweClose, forgetOwed, sweepOwed } from './owed.js';
import { ownerName } from './owner.js';
import { resolveFor } from './resolvers.js';
import { certificate, daysLeftOf, isSecure, tailnetServer, tlsEnabled, MIN_VERSION } from './tls.js';
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
import { normalizeDraft, topoOrder } from './draft.js';
// Two different "agents" now share this file, so the kinds are imported under a name
// that says which: lib/agents.js is the roster of reply personas you choose between,
// lib/agentview.js is the screen over the four agent KINDS and their foundations.
import { agentList, agentDetail, agentLog, logKeyFor, AGENTS as AGENT_KINDS } from './agentview.js';
import { amend, decline, displayName } from './foundation.js';
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
} from './spaces.js';
import { createEpicFiler, refFor as jiraRefFor } from './jiraepic.js';
import { createIngester } from './jiraingest.js';
import { createJiraPoller, jiraEveryMs } from './jirapoll.js';
import { createSweep, mergeTrouble, troubledNames } from './sweep.js';
import { createSyncer, syncEnabled, syncEveryMs, describeSync } from './sync.js';
import { dismissAsk, drop, excludedRinging, pruneDeclined, rangFor, retain as retainRinging } from './ringing.js';
import { recordAnswer, answeredBefore, answeredAgo, pruneAnswered } from './answered.js';
import { arrivedQuiet, quietArrival, retainQuiet } from './hushed.js';
import { describeAddressees, meHandles } from './addressee.js';
import { readAll as readActivity, activityFor, setActivity, clearActivity, pruneActivity } from './activity.js';
import * as presence from './presence.js';
import * as claims from './claims.js';
import { tailnetLine, watchForAddress } from './tailnet.js';

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

const json = (res, code, obj) => {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
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
 * that landed on the clients. `public/prs.js` put every other view on the delta stream
 * and then had to keep one wall-clock timer, asking `/api/deploys` every thirty seconds
 * for as long as a board was open, purely so that a deploy started somewhere else — the
 * Ship button on another device, an agent's own `POST /api/deploy`, the release queue
 * shipping itself — turned the strip on. One event here deletes that timer: a board
 * holds a socket, asks for nothing, and switches to its fast clock in the moment
 * something begins shipping.
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

export function createApp(cfg) {
  // The threshold the slow log fires at, and the only knob timing has. The counting
  // itself is never configurable: instrumentation you have to switch on is off for
  // every complaint you did not anticipate. See lib/timing.js.
  timing.configure({ slowMs: cfg.slowRequestMs });
  const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });
  const workspaces = new Map(cfg.workspaces.map((w) => [w.name, w]));
  const assetRoots = (cfg.assetRoots || []).map((r) => path.resolve(r));
  // Filled in by startPoller so a write here can update its comment baseline.
  const hooks = {};
  // What /api/poll parks on. The PWA ignores it and keeps re-polling; the Android
  // watch service lives on it.
  const bus = createEventBus();
  // One agent per repo, driving its queue to zero — see lib/advocate.js. It is
  // ticked by the poller rather than by a clock of its own: a bead becoming ready
  // is an event the daemon is already looking for every 30 seconds.
  const advocates = createAdvocates(cfg, { bd, bus });

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
    consoleList()
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
   * How many beads are asking you something — the app's premise, as a number.
   *
   * Held for exactly the reason `proposalsPending` is: the bar that draws it sits
   * above the inbox in every scope, and the `agent` scope sweeps no questions at
   * all. Counting the rows of the response would show "nothing is waiting" on the
   * one screen where nothing was even asked for. It is the questions channel only —
   * a foundation request is counted by the ⚖️ badge that is already in the bar, and
   * counting it twice would make the two disagree about the same bead.
   */
  let questionsPending = 0;

  /**
   * The same count, broken out by space and by workspace — what the space picker in
   * the top bar draws, on every page rather than only on the inbox.
   *
   * Cached from the last sweep for a reason the two counters above do not have: the
   * picker is on the PR board, the advocate console and the chat launcher too, and
   * none of those sweeps the tracker for questions. Recomputing it per request would
   * put `bd human list` across every workspace behind a control that is drawn on
   * every page load, which is the one cost this app is careful never to pay twice —
   * so /api/spaces serves this, and is a JSON read of two variables.
   *
   * Worst case it is one poll stale (thirty seconds), which is the same staleness the
   * inbox's own badge already accepts.
   */
  let spacesPending = [];
  let workspacePending = {};

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
   */
  const syncer = createSyncer({ bd });

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
   * The three numbers the inbox's top bar draws, and none of them costs a `bd` call.
   *
   * `liveSessions` is a readdir plus a JSON parse per session file — cheap enough for
   * the poll every client already makes, which is the whole reason these live on
   * /api/questions and the rest of the same picture lives on /api/work. That one is
   * two `bd` calls per workspace, about a second for six, and is opened when you want
   * it rather than every thirty seconds on a phone.
   */
  const summaryNow = () => ({
    // Every live session on this Mac, including the ones in no configured workspace —
    // the same set the sessions view lists, because a badge that counts a smaller set
    // than the page it links to is a badge that argues with its own destination.
    sessions: liveSessions(cfg).length,
    proposals: proposalsPending,
    questions: questionsPending,
  });

  /**
   * A client that owns a notification shade has been heard from.
   *
   * The Android watcher passes `shade=1` on every long-poll and nothing else does —
   * not the PWA, which draws no shade, and not the terminal monitor, which parks on
   * the same endpoint. That distinction is the whole value of the flag: without it,
   * `bin/monitor.js` running on the Mac would make the daemon believe there was a
   * phone tray to clear, and the filter-change prompt would offer to clear something
   * that does not exist. See lib/ringing.js.
   *
   * **Throttled to one write an hour**, because the watcher polls every 25 seconds and
   * a `saveState` is an atomic rewrite of state.json plus a snapshot commit. Nothing
   * downstream needs better than that: the value is read against a fortnight.
   */
  const SHADE_WRITE_MS = 60 * 60 * 1000;
  let shadeWrittenAt = 0;
  function noteShade() {
    const now = Date.now();
    if (now - shadeWrittenAt < SHADE_WRITE_MS) return;
    shadeWrittenAt = now;
    saveState({ shadeSeen: new Date(now).toISOString() });
  }

  /**
   * That bead's notification is gone — answered, commented on, or set aside.
   *
   * Called beside every `answered` / `commented` emit, because those are exactly the
   * events a shell cancels the row on. Waiting for the poller to notice would leave a
   * filter-change prompt counting rows that are no longer in anybody's shade, which is
   * the one number in this feature that has to be right.
   */
  function unring(key) {
    const state = loadState();
    if (!state.ringing[key] && !(state.ringingDeclined || []).includes(key)) return;
    saveState({
      ringing: drop(state.ringing, [key]),
      ringingDeclined: (state.ringingDeclined || []).filter((k) => k !== key),
    });
  }

  /**
   * The unread notifications the filter now excludes, for the payloads that carry it.
   *
   * Takes the *reconciled* filter, for the reason spelled out in `reconcileFilter`: a
   * saved filter naming a space nobody has any more matches nothing at all, and
   * "nothing matches" here would mean offering to clear the entire shade.
   */
  const askFor = (filter, state = loadState()) =>
    dismissAsk({
      cfg,
      ringing: state.ringing,
      declined: state.ringingDeclined,
      filter,
      shadeSeen: state.shadeSeen,
    });

  /**
   * The inbox's payload, in one place, because two endpoints have to answer with it.
   *
   * `/api/questions` is what a cold inbox asks for; `/api/poll` is what a warm one
   * parks on. They used to be different shapes — the poll carried the rows, the
   * spaces and nothing else — so a client that refreshed itself from the poll got a
   * list with no counts on the chrome, no filter to obey and no notification prompt,
   * and the only way to have those was to throw the poll away and sweep `bd` again.
   * That second sweep is the whole cost this exists to remove: the poll already only
   * wakes when something moved, so what it wakes with has to be everything.
   *
   * Built rather than spread from a constant because three of the five fields are
   * reads — `loadState` twice over would be two different states — and because the
   * filter has to be reconciled before `askFor` sees it. Both callers get the same
   * one, or the difference is a field that is right on a cold load and missing on
   * every refresh after it, which is the hardest kind of wrong to notice.
   *
   * `channels` is the one thing a caller has to say for itself: which sweeps went into
   * `rows`. It decides whose failures are reported — see `sweepTrouble`.
   */
  /**
   * The P0 board — which P0s are yours, and which of the rows below descend from one.
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
   * gets one string per row — the id of the P0 it hangs off, or nothing — and filters on
   * that. It also means the answer is the same on the phone, the laptop and the watch.
   *
   * **Closed P0s are not on the board.** A P0 that landed is not something to lead the
   * screen with, and its descendants stop being pulled in with it — which is the intended
   * end of an epic rather than a case to handle.
   *
   * One `bd export` per workspace, cached for a minute by `Bd.graph`, and it answers both
   * halves — see the note there for why this is not two commands.
   */
  async function p0Board(rows) {
    if (!meHandles(cfg).length) return { p0s: [], under: {}, owned: false };
    const p0s = [];
    const under = {};
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
        // no P0s and hides none of its rows — which is the safe direction: the inbox
        // over-shows rather than quietly dropping a question nobody would know to look for.
        continue;
      }
      const roots = new Set();
      for (const b of beads.values()) {
        if (String(b.status) === 'closed' || !isP0(b) || !ownedByMe(cfg, b)) continue;
        roots.add(b.id);
        p0s.push(p0Card(name, b, beads, parents));
      }
      if (!roots.size) continue;
      for (const r of rows) {
        if (r.workspace !== name) continue;
        const line = [r.id, ...ancestorsOf(parents, r.id)];
        const root = line.find((id) => roots.has(id));
        if (root) under[r.key] = root;
      }
    }
    // Highest-priority-then-oldest is the advocate's order; a board of P0s is all one
    // priority, so what is left is which has the most still open — the one with sixty
    // children left is the one the week is actually about.
    p0s.sort((a, b) => b.open - a.open || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
    return { p0s, under, owned: true };
  }

  /**
   * One P0, as the card at the top of the inbox draws it.
   *
   * The counts are of *descendants*, at any depth, not of direct children: an epic whose
   * five children are themselves epics has forty things open under it and "5" would be a
   * number that reads as almost done. Closed ones are excluded from both because the card
   * answers "what is left", and the fraction that would need the total is on the sheet.
   *
   * `waitingOn` is read off the bead's notes and is null until a P0 advocate has written
   * one (lib/epicadvocate.js). Null rather than a cheerful default on purpose: "not
   * waiting on anything" is a thing only an agent that has looked can say, and the card
   * draws nothing where this is null — so a P0 nobody has advocated yet is one line
   * shorter rather than one claim wronger.
   */
  function p0Card(workspace, bead, beads, parents) {
    const roots = new Set([bead.id]);
    let open = 0;
    let inFlight = 0;
    for (const b of beads.values()) {
      if (b.id === bead.id || String(b.status) === 'closed') continue;
      if (!underAnyOf(parents, b.id, roots)) continue;
      open += 1;
      if (String(b.status) === 'in_progress') inFlight += 1;
    }
    return {
      key: `${workspace}/${bead.id}`,
      workspace,
      id: bead.id,
      title: bead.title,
      status: bead.status,
      issue_type: bead.issue_type,
      owners: ownersOn(bead),
      open,
      inFlight,
      waitingOn: waitingOn(bead),
    };
  }

  async function inboxPayload(rows, requests, channels = ['questions', 'beads', 'foundation']) {
    // The JIRA read merged in with the `bd` ones, because it is the same claim they make
    // — *this list is missing things* — and a client that has never heard of JIRA then
    // draws the failure in the banner it already has, rather than drawing nothing about
    // a section that is quietly empty. Its own field below carries the unmerged record,
    // for the one thing merging costs: `mergeTrouble` keeps a single row per workspace,
    // so a Dolt lock arriving a second later would otherwise hide an expired token
    // behind a failure that clears itself on the next sweep.
    const trouble = mergeTrouble(...channels.map((c) => sweeps[c]).filter(Boolean), jira);
    const spaces = summarise(cfg, rows, troubledNames(trouble));
    const savedState = loadState();
    const filter = reconcileFilter(spaces, [...workspaces.keys()], savedState.filter);
    return {
      questions: rows,
      requests,
      workspaces: [...workspaces.keys()],
      spaces,
      // The repos this sweep could not read, named, with what `bd` said — see
      // lib/sweep.js. Its own field and empty almost always, so a client that has
      // never heard of it draws the inbox exactly as it did; and on the day it is not
      // empty, the alternative is a list that is quietly missing a repo and an empty
      // state claiming there is nothing to answer.
      trouble,
      // And the other kind of out-of-date, in its own field for the reason lib/sync.js
      // gives at `trouble()`: these two are not variants of one problem. A repo in
      // `trouble` is one this Mac could not read, so the list you are looking at is
      // stale and you can see that it might be. A repo in `syncTrouble` reads perfectly
      // — the list is exactly right about this Mac and silently wrong about everybody
      // else's, and there is nothing on the screen to notice. Merging them would let
      // the first, which happens most days, mask the second, which is the one nobody
      // finds out about on their own.
      syncTrouble: syncer.trouble(),
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
      tickets: jira.tickets().map((t) => ({
        ...t,
        space: spaceFor(cfg, t.workspace)?.name || null,
        ingest: jiraIngest.stateFor(t.workspace, t.key),
      })),
      // And which workspaces could not be asked, unmerged. The same rows ride `trouble`
      // above so the existing banner draws them with no client change at all; this is the
      // one a JIRA section should draw from, because nothing here can be masked by a
      // tracker read that failed a second later.
      jiraTrouble: jira.trouble(),
      // The conversations you have open, as rows the inbox draws for itself — see
      // `inboxConsoles`. Its own field rather than folded into `questions` for the
      // same reason `requests` is: a chat session is not a bead, it has no id in any
      // tracker and nothing about it can be answered, so a client that has never
      // heard of the field draws the inbox exactly as it did before. In here rather
      // than on `/api/questions` alone for the reason the rest of this is: a warm
      // inbox refreshing itself off the poll would otherwise drop every chat row the
      // moment anything else moved.
      consoles: inboxConsoles(),
      // The P0 board: which P0s you own, and which row below descends from which. Its
      // own field for the reason `requests` and `consoles` are — a client that has never
      // heard of it draws the inbox exactly as it did before, and `owned: false` says
      // out loud that this install has no `me` and the whole section is off. See `p0Board`.
      // Named `p0board` rather than `board` because the client already has a `state.board`
      // and it is the *pull request* board — two boards on one page is one too many.
      p0board: await p0Board(rows),
      filter,
      dismissAsk: askFor(filter, savedState),
      summary: summaryNow(),
    };
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

  /** Every open human-labelled issue, across every workspace. */
  async function allQuestions() {
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
          const rows = await bd.listHuman(ws);
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
    // The inbox's own count, taken here so it is whatever the last sweep saw rather
    // than whatever this request asked for. An advocate's ask is one of these too:
    // it arrives as an ordinary question and is answered like one, so leaving it out
    // would put a card on screen that the number above it denies.
    const inbox = splitChannels(rows).questions;
    questionsPending = inbox.length;
    // Counted over the questions channel only, exactly like the number above it, so the
    // picker and the "3 waiting" chip beside it can never disagree about the same bead.
    //
    // The troubled repos ride along so the picker's rows carry `unknown` rather than a
    // number that is arithmetic over a sweep with a hole in it. The count itself is
    // still the best answer there is — it just stops being presented as a fact.
    spacesPending = summarise(cfg, inbox, troubledNames(sweepTrouble(['questions'])));
    workspacePending = inbox.reduce((acc, q) => {
      acc[q.workspace] = (acc[q.workspace] || 0) + 1;
      return acc;
    }, {});
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
  async function foundationRequests() {
    const store = readActivity();
    const results = await Promise.all(
      cfg.workspaces.map(async (ws) => {
        try {
          const rows = await bd.listLabel(ws, AMENDMENT_LABEL);
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
  async function agentBeads() {
    const store = readActivity();
    const results = await Promise.all(
      cfg.workspaces.map(async (ws) => {
        try {
          const rows = await bd.listAgent(ws);
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
   * The option a client says it tapped, as the bead defines it — or null.
   *
   * `/api/respond` needs one thing the answer sentence cannot carry: whether the
   * button that produced it commissions work (`closes: false`) or settles the
   * question. The clients send the option's id alongside the text, and this is where
   * that id is turned back into the option the agent actually wrote.
   *
   * Deliberately a fresh `bd show` rather than a trusted field on the request. The
   * card in front of you can be a poll out of date, and an option's meaning is the
   * bead's to state — see `optionById` in lib/decision.js. Null for a typed answer,
   * which names no option, and for an id the bead does not carry; both then fall
   * through to a close, which is the only behaviour there has ever been.
   */
  async function chosenOption(ws, id, optionId) {
    if (!String(optionId || '').trim()) return null;
    let issue = null;
    try {
      issue = await bd.show(ws, id);
    } catch {
      // Not being able to ask is not "it commissions work". The gate below asks bd
      // the same way a moment later and fails the same way, and an answer that
      // cannot be looked up should end where answers have always ended.
      return null;
    }
    return issue ? optionById(toQuestion(ws.name, issue), optionId) : null;
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
    // Where the approved beads land, resolved once for the batch: the P0 the card you
    // just approved sits under, or the unsorted backlog (lib/homing.js). Without it, a
    // tap that says "yes, do this work" files beads the advocate is then refused at the
    // door for having no P0 above them — the approval and the hold contradicting each
    // other with nothing on screen reconciling them. bc-rfnr.8.
    //
    // `homeIn` waits for the export (~1.3s for one workspace), which the poll path may
    // never do — but this is not the poll path. It is a tap that already spends a `bd`
    // subprocess per bead it is about to create, and the alternative on a cold cache is
    // no parent at all, which is the bug. Once, for the batch, and not inside the loop.
    const { parent: home } = await homeIn(bd, ws, { from: id });
    try {
      for (const bead of toCreate) {
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
            deps: bead.deps,
            parent: home,
            // `advocate` marks provenance: these were proposed by an agent and
            // approved by you, which is worth being able to search for later.
            labels: ['advocate', ...bead.labels],
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

    const gate = await bd.closeGate(ws, workId);
    if (!gate) {
      try {
        await bd.close(ws, workId, reason, { actor });
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
    const card = slug ? pickCard(await collectBoard(bd, cfg), { workspace: ws.name, slug }) : null;
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
          (!finished ? 'no work bead named' : finished.closed ? `closed ${d.bead}` : `${d.bead} stays open — ${finished.why}`)
      );
      bus.emit({ type: 'merged', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
      // What the card says happened has to be what happened. A refused close reported
      // as a close is how bc-ec6 ended up with two answers on two cards, each saying
      // it had closed a bead that was open the whole time — and reading either one
      // back tells you the work is finished when it is not. See lib/owed.js.
      const note =
        `Merged #${d.number}${landed}` +
        (!finished ? '' : finished.closed ? ` — closed ${d.bead}` : ` — **${d.bead} is still open:** ${finished.why}. It closes as soon as that clears`) +
        '.';
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
      if (d.bead && d.bead !== id) {
        // Yours. The heading is the daemon's wrapper, but `note` is verbatim what you
        // typed, and "who asked for changes" is the first thing the next session wants
        // to know. The reopen below is not attributed: putting a bead back in the queue
        // is bookkeeping, like the `human-replied` label.
        await bd.comment(
          ws,
          d.bead,
          `## Changes requested on #${d.number}\n\n${note}\n\nThe branch \`${d.branch}\` is still open — push to it, do not start a new one.`,
          { actor }
        );
        await bd.reopen(ws, d.bead).catch((err) => console.error(`[pr] ${ws.name}: could not reopen ${d.bead} — ${err.message}`));
      }
      console.log(`[pr] ${ws.name}: changes requested on #${d.number} — ${d.bead || '(no bead)'} back in the queue`);
      // The sweep the board is cached from is now wrong about the row this changed, and
      // the boards that will come asking are the ones the event below is about to wake.
      // Dropped here rather than left to each of them sending `?refresh=1`: that would be
      // one `gh` sweep per open board where this is one for all of them. Same call and
      // the same reasoning as the merge path above.
      forgetBoard(dir);
      bus.emit({ type: 'changes', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
      return {
        note: `Changes requested on #${d.number} — ${d.bead || 'the work'} is back in the queue.`,
        result: { action: 'changes' },
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
    if (d.bead && d.bead !== id) {
      await bd.comment(
        ws,
        d.bead,
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
      await bd.reopen(ws, d.bead).catch((err) => console.error(`[pr] ${ws.name}: could not reopen ${d.bead} — ${err.message}`));
    }
    console.log(`[pr] ${ws.name}: declined #${d.number}${why ? ' with direction' : ' with no direction given'}`);
    // As above: one sweep for every board this wakes, rather than one each.
    forgetBoard();
    bus.emit({ type: 'pr-declined', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
    return {
      note: `Declined #${d.number}${why ? ' with direction' : ''} — ${d.bead || 'the work'} is back in the queue.`,
      result: { action: 'decline', directed: Boolean(why) },
      deploy: null,
    };
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
    if (!space || space === 'all') return { picked: cfg.workspaces || [], workspace: '', space: space || 'all' };

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
   * The signed-in address on this request, or null.
   *
   * `sessionKey()` reads a file, so it is resolved once per process rather than per
   * request — the key never changes under a running daemon, and deleting it (the only
   * global revocation there is) is meant to take a restart or a swap.
   */
  let sigKey = null;
  function sessionOf(req) {
    if (!authNow()) return null;
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    sigKey = sigKey || sessionKey();
    return verifySigned(raw, sigKey);
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
         * questions to and lib/ownership.js stamps on a P0.
         *
         * Not the same as `email` above and deliberately offered alongside it. That one
         * is whoever is signed into this browser, which on a phone borrowed at a desk is
         * not necessarily the person whose laptop is running the daemon. The bead sheet
         * offers both as one-tap suggestions and lets the thumb decide, rather than
         * guessing — a P0 stamped with the wrong owner is worse than one left unowned,
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

      console.log(`[auth] signed in ${claims.email}`);
      return redirect(res, safeNext(flight.next), {
        'set-cookie': [spent, sessionCookie(auth, claims, sigKey)],
      });
    }

    return json(res, 404, { error: 'no such auth route' });
  }

  async function serveStatic(req, res, url, urlPath) {
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
    if (urlPath === '/work' || urlPath === '/sessions' || urlPath === '/work.html') urlPath = '/monitor.html';
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
    // the path and puts the PRs chip up. `/pulls` because GitHub calls that tab Pull
    // requests and half the time that is the word you will reach for; `/prs.html` for
    // the reason `/work.html` is above it, that the file behind it is deleted and
    // without this line it is the one path of the three that breaks.
    if (urlPath === '/prs' || urlPath === '/pulls' || urlPath === '/prs.html') urlPath = '/monitor.html';
    // The endorsement queue — the beads an agent filed that nobody has looked at yet.
    // Three paths because the screen has two honest names: it is the place you
    // *endorse* things, and it is the *queue* of what is waiting, and which word comes
    // to mind depends on whether you arrived from a notification or went looking.
    if (urlPath === '/endorse' || urlPath === '/queue' || urlPath === '/endorsements') {
      urlPath = '/endorse.html';
    }
    if (urlPath === '/foundations') urlPath = '/foundations.html';
    // The ledger — every bead the selected space has ever had (bc-nib3.2). One path
    // and not three, unlike its neighbours above: it is a tab on the bottom bar, so
    // the bar itself is the only thing that has ever pointed at it and there is no
    // older name on anybody's home screen to keep working.
    if (urlPath === '/history') urlPath = '/history.html';
    // The in-app terminal, with or without a terminal id in the query.
    if (urlPath === '/terminal') urlPath = '/term.html';
    // The advocate console — what bin/monitor.js showed in one line per repo, in
    // full, and the sessions view with it (see `/work` above). `/advocates` too,
    // because two people will guess two different names for it and the LaunchAgent
    // only ever opens one of them.
    if (urlPath === '/monitor' || urlPath === '/advocates') urlPath = '/monitor.html';
    // The sign-in screen, and the one page that is never gated — see the gate below.
    // It is also where a browser is sent when it has no credential at all, so it has
    // to answer to the short path a person would type.
    if (urlPath === '/login') urlPath = '/login.html';
    // Pause all / resume all. Its own page rather than a block on the console: it is
    // the one control here that stops everything at once, and a screen you visit
    // constantly is the wrong place to keep a button like that.
    if (urlPath === '/admin') urlPath = '/admin.html';
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
          // `questions`, `requests`, `workspaces`, `spaces`, `consoles`, `filter`,
          // `dismissAsk` and `summary`, all of them built by `inboxPayload` above —
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
        return json(res, 200, { requests, workspaces: [...workspaces.keys()] });
      }

      if (p === '/api/question' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = url.searchParams.get('id');
        const issue = await bd.show(ws, id);
        if (!issue) return json(res, 404, { error: 'not found' });
        const q = toQuestion(ws.name, issue);
        q.comments = await bd.comments(ws, id);
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
        const { unit } = requireUnit({ key: url.searchParams.get('key'), workspace: url.searchParams.get('workspace') });
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
       * board must not be twice the `gh` traffic of one.
       */
      if (p === '/api/prs' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        const board = await collectBoard(bd, cfg, { force });
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
       * to touch a checkout with uncommitted work in it.
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
        const land = await landLocally(dir, row.base || cfg.pr?.base || 'main');
        // The sweep this came from is now wrong about the one row anyone is looking at, and
        // so is `gh`'s own answer about this checkout — which is why the directory is named.
        forgetBoard(dir);
        const base = row.base || cfg.pr?.base || 'main';
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
        const commission = (await chosenOption(ws, body.id, body.option))?.closes === false;
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
        // pass `--force` — a bypass that cannot bypass anything is a trap.
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
          // Said on the thread rather than left to be inferred from the labels: the
          // next reader of this bead is an agent that has to know it is being given
          // work, not shown a decision somebody else already acted on.
          commission ? 'Left open and handed back — this answer commissions the work rather than finishing it.' : '',
        ].filter(Boolean);
        const answer = record.length ? `${response}\n\n${record.join('\n')}` : response;
        if (commission) await bd.commission(ws, body.id, answer, { actor: who });
        else {
          await bd.respond(ws, body.id, answer, { actor: who });
          // Answered and closed on disk — so it must not be handed back by a sweep of
          // this repo that fails before the next one succeeds. The rows we hold for an
          // unreadable workspace stand in for an answer nobody could get; they are not
          // a record to argue with a write we have just made. See lib/sweep.js.
          sweeps.questions.forget(ws.name, body.id);
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
        if (commission) {
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
            commission ? ' — left open and handed back as ready work' : ''
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
            verb: commission ? 'Handed back' : 'Answered',
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
          handedBack: commission,
          created,
          declined,
          // Rows an approval asked for that already existed. Additive, like every other
          // field here: a cached service worker and the installed Android build have
          // never heard of it and must keep working.
          skipped,
          amendment: amended.result,
          delivery: delivered.result,
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

        // What has to change before this comes back. Asked now rather than on every
        // sweep, so the common case — a card you dismissed and never think about
        // again — costs one `bd show` once, not one per poll forever.
        const hold = (await bd.hold(ws, body.id)) || { gate: null, comments: 0 };
        // Baseline the reply poller on our own write, exactly as `/api/comment` does.
        // It was safe without this only because the note was written as `cfg.actor`
        // and `checkReplies` filters that author out; a note now carrying *your*
        // address would come back as "an agent replied" the next time this bead is in
        // the sweep. Free here — `hold` has already counted the comments.
        hooks.rebaseline?.(key, hold.comments);
        const dismissed = { ...loadState().dismissed };
        dismissed[key] = {
          at: new Date().toISOString(),
          // The gate is the trigger when there is one: an epic comes back when its
          // children are done, a blocked bead when its blockers close. That is the
          // moment it stops being a question's future and becomes a question.
          gate: hold.gate ? { kind: hold.gate.kind, reason: hold.gate.reason } : null,
          // And when there is no gate, nothing about the bead will change on its
          // own — so the only honest trigger left is somebody saying something new.
          comments: hold.comments,
          note: note || null,
        };
        saveState({ dismissed });
        console.log(
          `[beadcause] dismissed ${key} — ${
            hold.gate ? `back when ${hold.gate.reason} clears` : 'back on the next comment'
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
        return json(res, 200, { ok: true, closed: false, dismissed: true, until: hold.gate?.reason || null });
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
        const names = [...workspaces.keys()];
        // Before the first sweep has landed there are no counts, and a picker drawn
        // from an empty list would put every space's workspaces under the synthetic
        // "Other" group for the few seconds until the poller finishes. The shape of
        // the spaces is config, not tracker — so ask config for it and let the counts
        // be zero, which is the honest thing to say about a sweep that has not run.
        const spaces = spacesPending.length ? spacesPending : summarise(cfg, []);
        return json(res, 200, {
          spaces,
          workspaces: names,
          // Per workspace rather than per space as well: the picker derives a space's
          // total from `spaces[].count`, and two numbers for the same thing computed
          // two ways is how they start disagreeing.
          counts: workspacePending,
          // Which of those counts are missing a repo that did not answer. The picker
          // is drawn on four pages that never sweep the tracker, so without this they
          // would be the four screens most confident about a number nobody checked.
          //
          // The questions channel alone, because that is the channel `counts` is over:
          // the ⚠ has to be about the number it is drawn beside, or it would appear on
          // a figure that is perfectly correct and say nothing about the one that is not.
          trouble: sweepTrouble(['questions']),
          filter: reconcileFilter(spaces, names, saved.filter),
          // What the inbox's own chip says, so a picker drawn beside it on a page that
          // has no inbox can still say how much is waiting in total.
          waiting: questionsPending,
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
        return json(res, 200, found);
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
         * A `workspace` in the body makes this the *repo row's* write instead — one
         * setting deep, `autoEndorse`, which is the one answer here that does not group
         * by space (see `autoEndorseAllowed`).
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

        // Declining is remembered per bead and only while that bead is excluded, so a
        // filter change is where the memory is trimmed: widening forgets what you
        // declined, because the question stopped being a question the moment the bead
        // came back into view. Pruned against the *new* filter and before the ask is
        // computed, so narrowing again is a fresh ask rather than an inherited silence.
        const state = loadState();
        const declined = pruneDeclined(state.ringingDeclined, excludedRinging(cfg, state.ringing, filter));
        saveState({ filter, ringingDeclined: declined });

        const ask = askFor(filter, { ...state, filter, ringingDeclined: declined });
        if (ask) {
          // "now excludes" rather than "narrowed to", because a sideways move — Personal
          // to Work — excludes a different set without narrowing anything, and the log
          // has to describe what happened rather than what usually happens.
          console.log(
            `[beadcause] filter ${describeFilter(filter)} now excludes ${ask.count} unread notification(s), asking: ${ask.keys.join(', ')}`
          );
        }
        // The ask rides the response rather than waiting for the next poll: this is the
        // request the tap made, and "at the moment of the change" is the only moment
        // where clearing them is obviously the same act as narrowing the filter.
        return json(res, 200, { ok: true, filter, dismissAsk: ask });
      }

      /**
       * Clear — or deliberately keep — the notifications a filter change excludes.
       *
       * **This is not `/api/dismiss`, and the two must not be confused.** That one is an
       * inbox act on a card: the bead is acknowledged, it leaves the list, and something
       * has to bring it back. This one touches nothing but the shade. The bead stays
       * open, stays unanswered, stays in the list, and turns up on the phone again the
       * moment the filter widens — all that has happened is that a row you had already
       * decided to stop thinking about stopped sitting in your notifications.
       *
       * Which is why it emits `dismissed` rather than `answered`. Every client cancels
       * on `answered` *and* treats the bead as decided; a shell that reused it here
       * would be told a bead had been answered when nobody had answered anything, and
       * `bd` never hears about this at all.
       *
       * `confirm: false` is not a no-op — it is the record of a decline, and it is what
       * stops the next sweep asking the same question again.
       */
      if (p === '/api/notifications/dismiss' && req.method === 'POST') {
        const body = await readBody(req);
        const state = loadState();
        // The same sweep `/api/questions` does, and it is not avoidable here: the space
        // list is what `reconcileFilter` needs, and reconciling against a short list
        // would drop a filter pinned to the synthetic "Other" group — which reads as a
        // filter of `all`, under which nothing is excluded and nothing would be cleared.
        // One sweep on a button you press a few times a day.
        const filter = reconcileFilter(summarise(cfg, await allQuestions()), [...workspaces.keys()], state.filter);
        const ask = askFor(filter, state);
        // Only what is *currently* being asked about, intersected with what the client
        // says it was shown. A bead that started ringing after the prompt was drawn is
        // not covered by the tap that answered it, and a stale `keys` list from a phone
        // that has been asleep must not clear a notification you have not seen.
        const offered = new Set(ask?.keys || []);
        const asked = Array.isArray(body.keys) ? body.keys.filter((k) => offered.has(k)) : [...offered];

        if (!body.confirm) {
          const declined = [...new Set([...(state.ringingDeclined || []), ...asked])];
          saveState({ ringingDeclined: declined });
          if (asked.length) console.log(`[beadcause] left ${asked.length} notification(s) on the phone: ${asked.join(', ')}`);
          return json(res, 200, { ok: true, cleared: 0, left: asked.length, dismissAsk: null });
        }

        for (const key of asked) {
          const rec = state.ringing[key];
          bus.emit({
            type: 'dismissed',
            key,
            workspace: rec?.workspace || key.slice(0, key.indexOf('/')),
            id: rec?.id || key.slice(key.indexOf('/') + 1),
            // Why, for the log and for a client that wants to say so. There is exactly
            // one reason today, and naming it beats a client inferring it.
            reason: 'filtered',
          });
        }
        // Out of `ringing` and out of `ringingDeclined` both: the row is gone, so there
        // is nothing left to ask about and nothing left to have declined.
        saveState({
          ringing: drop(state.ringing, asked),
          ringingDeclined: (state.ringingDeclined || []).filter((k) => !asked.includes(k)),
        });
        if (asked.length) {
          console.log(
            `[beadcause] cleared ${asked.length} notification(s) the filter excludes: ${asked.join(', ')} — the beads are untouched`
          );
        }
        return json(res, 200, { ok: true, cleared: asked.length, left: 0, dismissAsk: null });
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
        // One line per collision and none per ordinary claim: this runs thousands of
        // times a day and only the collisions are worth a log.
        if (out.decision === 'conflict' || out.insisted) {
          const who = out.holders.map((h) => h.branch || h.session).join(', ');
          console.log(
            `[beadcause] ${out.insisted ? 'claimed anyway' : 'claim refused'}: ${out.record.label}/${out.record.file}` +
              ` wanted by ${out.record.branch || out.record.session}, held by ${who}${out.sameTree ? ' IN THE SAME WORKTREE' : ''}`
          );
        }
        return json(res, 200, {
          ok: true,
          decision: out.decision,
          insisted: out.insisted,
          sameTree: out.sameTree,
          holders: out.holders,
          reason: out.decision === 'conflict' ? claims.refusalFor(out.record.file, out) : '',
        });
      }

      if (p === '/api/claims' && req.method === 'DELETE') {
        const body = await readBody(req);
        const files = Array.isArray(body.files) ? body.files : null;
        const released = claims.release(body.session, { files });
        if (released) console.log(`[beadcause] released ${released} file claim(s) for session ${body.session}`);
        return json(res, 200, { ok: true, released });
      }

      if (p === '/api/claims' && req.method === 'GET') {
        return json(res, 200, { claims: claims.list(), collisions: claims.collisions() });
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
        // And a watcher that owns a notification shade, which is a different claim from
        // wanting the questions: the Android shell posts rows into a tray it can cancel
        // later, and it is the only client that can. Recorded before the park, so a
        // phone that spends its life in a 25-second long-poll still counts as present.
        if (url.searchParams.get('shade') === '1') noteShade();
        // A `since` from the future means the daemon restarted and the counter went
        // back to zero. Without this the phone would park forever waiting for a
        // sequence that can never arrive, and go deaf until the server caught up.
        if (since > bus.seq) {
          const fresh = wantsQuestions ? splitChannels(await allQuestions()) : null;
          return json(res, 200, {
            seq: bus.seq,
            resync: true,
            events: [],
            workspaces: [...workspaces.keys()],
            ...(fresh
              ? await inboxPayload(fresh.questions, fresh.requests, ['questions'])
              : { questions: null, requests: null, spaces: null }),
            advocates: advocates.snapshot(),
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
          workspaces: [...workspaces.keys()],
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
          advocates: advocates.snapshot(),
          observing: OBSERVING,
          // Same reasoning, and the mirror's whole input: it follows this list, so it
          // must arrive on the poll that woke for it rather than a tick later.
          presence: presence.list(),
        });
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
          workspaces: [...workspaces.keys()],
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
       * unnamed workspace goes to the first configured one, which is the daemon's own.
       * A caller that does know (bc-p38c.4's daemon-side handler, a script) may say.
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
        const ws = body.workspace ? requireWorkspace(body.workspace) : cfg.workspaces[0];
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
          const out = await intakeError(bd, ws, { ...body, message }, { actor: actorFor(req) });
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
        return json(res, 200, { consoles: consoleList(), workspaces: [...workspaces.keys()] });
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
          workspaces: [...workspaces.keys()],
        });
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
        return json(res, 200, { agent: await agentDetail(dir, id), workspace: ws.name });
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
       * three real beads unmentioned is the worse failure.
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

        try {
          for (const ref of sequence) {
            const b = byRef.get(ref);
            if (!b) continue;
            const parent = b.parent ? await resolve(b.parent) : null;
            if (b.parent && !parent) warnings.push(`${b.ref}: parent ${b.parent} does not exist — created without it`);
            const id = await bd.create(
              ws,
              {
                title: b.title,
                body: b.description,
                type: b.type,
                priority: b.priority,
                // Exactly the labels on the card — which is normally none. `bd.create`
                // defaults to `['human']` for /api/ask's benefit, and inheriting that
                // here would file every bead as a question and put the lot in your
                // inbox waiting for an answer nobody is asking for.
                labels: b.labels,
                acceptance: b.acceptance,
                design: b.design,
                notes: b.notes,
                parent: parent || '',
              },
              // The agent argued these into shape; pressing the button is what made
              // them exist, and `created_by` records the press. The `bd dep add` calls
              // below are not attributed — wiring beads together is plumbing.
              { actor: actorFor(req) }
            );
            if (!id) throw new Error(`bd created "${b.title}" but returned no id`);
            ids.set(b.ref, id);
            created.push({ ref: b.ref, id, title: b.title });
            const dup = flagged.get(b.ref);
            if (dup) {
              console.log(
                `[beadcause] console ${c.id}: created ${id} over a flagged duplicate — ${dupeNote(dup)}, and you said so`
              );
            }
          }

          for (const { ref, id } of created) {
            for (const dep of byRef.get(ref)?.dependsOn || []) {
              const target = await resolve(dep);
              if (!target || target === id) {
                warnings.push(`${id}: dependency on ${dep} skipped — no such bead`);
                continue;
              }
              await bd.addDep(ws, id, target);
            }
          }
        } catch (err) {
          const detail = err.message.split('\n')[0];
          console.error(`[beadcause] console ${c.id}: create failed after ${created.length} — ${detail}`);
          if (created.length) recordCreated(c, created, [...warnings, `stopped after an error: ${detail}`]);
          return json(res, 502, { error: detail, created, warnings });
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
        return json(res, 200, { ok: true, consoles: consoleList() });
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
        // Read off the filesystem before the bd sweep, so every workspace row is
        // matched against the same snapshot of what was running.
        const sessions = liveSessions(cfg);
        const rows = await collectWork(bd, cfg.workspaces, readActivity(), sessions);
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
          advocates: advocates.snapshot(),
          // And the numbers that belong to no repo — the cap across every advocate,
          // the range its stepper may offer, and how much of it is in use right now.
          // Sent separately rather than read off the first advocate card, because the
          // console filters those by space and this cap does not.
          globals: advocates.globals(),
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
       */
      if (p === '/api/advocate' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (action === 'globalLimit') {
          if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
          advocates.setGlobalLimit(body.value);
          return json(res, 200, { ok: true, advocates: advocates.snapshot(), globals: advocates.globals() });
        }
        const name = String(body.workspace || '');
        if (!advocates.has(name)) return json(res, 404, { error: `no advocate for ${name || '(none given)'}` });
        await advocates.control(name, action, body.value);
        return json(res, 200, { ok: true, advocates: advocates.snapshot(), globals: advocates.globals() });
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
       */
      if (p === '/api/graph' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (id && !BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        // Two bd calls, in parallel. The graph page is the slow one — it walks the
        // whole dependency graph, five seconds on deluvia — and asking for the dates
        // afterwards would add a second call's latency to a request that is already
        // the slowest thing the phone waits on.
        const [html, rows] = await Promise.all([
          bd.graphHtml(ws, id || null),
          // The annotation is a bonus, not the payload: a list that fails still
          // leaves a drawable graph, with every node simply undated and unmarked.
          // Losing the whole graph over it would be a bad trade.
          bd.listStatus(ws, 'open,in_progress,blocked').catch(() => []),
        ]);
        const { since, kind } = movedSince(liveSessions(cfg), ws.name);
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
        // bd exits non-zero for an id that doesn't exist, so an unknown bead would
        // otherwise surface as a 500 — and the drawer would say the server broke
        // when the truth is you tapped something that has since been deleted.
        let issue;
        try {
          issue = await bd.show(ws, id);
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
        const workable = hasP0Above(await bd.graph(ws, { wait: false }), id);
        return json(res, 200, { ...issue, workspace: ws.name, noP0: !workable, comments: await bd.comments(ws, id) });
      }

      /**
       * What is under a bead — every child, closed ones included.
       *
       * A route of its own rather than a field on `/api/bead`, because children are not
       * in `bd show` at all (see `Bd.children`) and fetching them is a second `bd`
       * invocation. Folded into `/api/bead` it would be a call every sheet waits on,
       * and most beads you tap are leaves with nothing under them. So the sheet paints
       * from `/api/bead` and asks for this afterwards, appending it when it lands.
       *
       * An id that does not exist is an empty list here, not a 404: `bd list` answers
       * `[]` for an unknown `--parent` where `bd show` exits non-zero, and the sheet
       * cannot reach this route for a bead that does not exist anyway — `/api/bead`
       * has already 404'd and no children call is made.
       */
      if (p === '/api/bead-children' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const id = String(url.searchParams.get('id') || '');
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        return json(res, 200, { workspace: ws.name, id, children: await bd.children(ws, id) });
      }

      /**
       * Who is answerable for this bead — set it, move it, or hand it back to nobody.
       *
       * **A route of its own rather than a field of `/api/bead/adjust`, and the reason is
       * what the two are for.** Adjust rewrites a bead that has not been endorsed yet: it
       * refuses a bead anybody has agreed to work, because rewriting one over a stale
       * queue row is the failure lib/verdict.js exists to prevent. Ownership is the
       * opposite kind of fact — it is most worth changing on a P0 that is *live*, months
       * into it, when the person who filed it is no longer the person carrying it. Folded
       * into adjust it would have inherited a refusal that makes no sense here.
       *
       * It is also why `owner:` is protected from the ✎ (`isProtectedLabel`): the sheet
       * posts the label set it is showing, and a handle nobody typed into that box would
       * be removed by the save. Two doors, and only this one moves ownership.
       *
       * **Any bead, not only a P0.** The stamp at filing time is P0-only (lib/bd.js) — that
       * is where the default belongs, because P0 is the priority somebody has to be
       * answerable for. Refusing to *record* an owner on a P1 would be a different claim
       * and a wrong one: a bead promoted to P0 next week should not need its ownership
       * re-decided, and bc-rfnr.5's triage sets owners on beads before it raises them. The
       * response says whether this bead is a P0 so a client can draw the difference.
       *
       * An empty `owner` is a legitimate answer and means nobody — the way a P0 filed
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
        return json(res, 200, { workspace: ws.name, id, owner: owners[0] || null, owners, p0: isP0(issue), changed });
      }

      /**
       * The P0s a bead could be adopted under — what the sheet offers when one is held.
       *
       * bc-rfnr.7 refuses a bead with no P0 above it, and a refusal whose fix is not on
       * the same screen is the cap lib/advocate.js's own rule forbids: loud, and
       * actionable from the phone that is showing it. This is the list behind that
       * control, and it is deliberately **every open P0 in the workspace, not only
       * yours** — the gate measures against all of them (lib/underp0.js), so offering a
       * narrower set would mean the sheet could not express half the adoptions that
       * would actually work.
       *
       * Off the cached graph, which the inbox has usually just warmed, and `wait: true`
       * unlike the inbox's own read: this is a tap rather than a repaint, and a cold
       * cache answering `[]` would draw "there are no P0s" over a tracker full of them.
       * A second and a half on the rare cold one is the right side of that trade.
       */
      if (p === '/api/p0s' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const { beads } = await bd.graph(ws);
        const roots = p0RootsOf(beads);
        const p0s = [...roots]
          .map((id) => beads.get(id))
          .filter(Boolean)
          .map((b) => ({ id: b.id, title: b.title, owners: ownersOn(b), mine: ownedByMe(cfg, b) }))
          // Yours first — on a shared graph most P0s belong to somebody else, and the one
          // you are adopting under is almost always one of your own. Then by id, so the
          // list is stable between two taps rather than reordering under a thumb.
          .sort((x, y) => Number(y.mine) - Number(x.mine) || String(x.id).localeCompare(String(y.id), 'en', { numeric: true }));
        return json(res, 200, { workspace: ws.name, p0s });
      }

      /**
       * Adopt a bead under a P0 — the fix for the one refusal that never clears itself.
       *
       * Every other reason a bead is held resolves on its own: a window closes, a pull
       * request merges, an epic's children get done, another Mac's claim expires. "No P0
       * above this" waits for somebody to decide the work belongs somewhere, and this is
       * that decision arriving from a phone.
       *
       * **The parent is checked against the open P0s rather than merely existing**, and
       * the refusal names which of the two it failed: adopting a bead under a *non*-P0
       * that is itself an orphan moves it without making it workable, which is the most
       * disappointing possible outcome for a control whose entire promise is that the
       * bead becomes workable. A parent under an open P0 is allowed, though — a bead
       * belongs beneath the epic it is part of, not directly under the root — so the test
       * is `hasP0Above`, the same predicate the gate itself asks.
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
          if (!hasP0Above(index, parent)) {
            return json(res, 409, {
              error: `${parent} has no P0 above it either, so adopting ${id} under it would not make it workable`,
            });
          }
        }
        await bd.adopt(ws, id, parent, { actor: actorFor(req) });
        // The board and the gate both read `Bd.graph`, which `adopt` has just refreshed —
        // so the answer here is the state the next tick will act on rather than a promise
        // about it. `workable` is what the sheet redraws from.
        const index = await bd.graph(ws);
        return json(res, 200, { workspace: ws.name, id, parent: parent || null, workable: hasP0Above(index, id) });
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
        // `workspace` echoes what was asked for and is `''` for a space or for all of
        // them — the rows carry their own, so a merged list can still label them. `query`
        // rides along because the client draws its own filter chrome from the URL and a
        // clamped `limit` is the one value it did not choose.
        return json(res, 200, { workspace, space, query, ...out });
      }

      /**
       * Put a P0 advocate on this P0 — the button on the inbox card.
       *
       * **A tap and not a loop, and that is the whole of what is decided here.** bc-rfnr.3
       * argues the agent should be re-opened on child events; nothing does that yet, and
       * the honest intermediate is the one where a person chooses. It costs an unattended
       * window that files beads, so a person choosing is not a weaker trigger than a loop —
       * it is the trigger every other unattended window in this app already has behind it
       * somewhere.
       *
       * **Never two on one P0.** `liveSessions` is matched on the window name, which
       * carries the bead id — the same discipline lib/advocate.js keeps and for the same
       * stated reason: it knows it launched a window for a bead, it does not know that a
       * given `claude` process is that window. So this is a 409 rather than a promise, and
       * the honest failure is refusing a second one you asked for rather than opening it.
       *
       * `OBSERVING` blocks it, unlike the verdict routes: those are you deciding, and this
       * one is the daemon acting — an observer instance must not open windows.
       *
       * The four refusals in front of it live in `openEpicAdvocateSession`, and all four
       * come back as a 409 with a sentence: unendorsed, superseded, closed, or not a P0
       * anybody owns. A button that silently does nothing is worse than one that says why.
       */
      if (p === '/api/bead/advocate' && req.method === 'POST') {
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const id = String(body.id || '').trim();
        if (!BEAD_ID_RE.test(id)) return json(res, 400, { error: 'not a bead id' });
        const already = liveSessions(cfg).find((sn) => String(sn.name || '').includes(id));
        if (already) {
          return json(res, 409, {
            error: `${id} already has a session open on it — one advocate per P0, never two`,
            live: already.name || null,
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
          reason: 'somebody asked for you from the P0 card on the phone',
          bd,
        });
        console.log(`[beadcause] P0 advocate opened on ${ws.name}/${id}`);
        bus.emit({ type: 'advocate', key: `${ws.name}/${id}`, workspace: ws.name, id });
        return json(res, 200, { workspace: ws.name, id, opened: true, repo: opened.repo || null });
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
       * to that cache is drop it outright — see `announceVerdict`.
       *
       * The rows are fat on purpose and the reason is in lib/endorsequeue.js: this is
       * the one screen where the decision *is* reading the bead.
       */
      if (p === '/api/unendorsed' && req.method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1';
        return json(res, 200, await endorsementQueue(bd, cfg.workspaces, { refresh }));
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

  return { handler, allQuestions, foundationRequests, splitChannels, bd, hooks, bus, advocates, syncer, jira, jiraEpics, jiraIngest };
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
  async function checkReplies(questions, filter, rang) {
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

      const incoming = comments.slice(seen).filter((c) => c.author && c.author !== cfg.actor);
      if (!incoming.length) continue;

      const latest = incoming[incoming.length - 1];
      // Emit before pushing: the app's own notification should not be gated on
      // ntfy.sh being reachable.
      //
      // A reply is as quiet as the bead it is on. Answering the filter separately
      // here would be the one way a filtered-out bead could still reach the phone:
      // you narrow the inbox to one workspace, hear nothing about a question in
      // another — and then get buzzed the moment an agent says something on it.
      //
      // Which is also why a reply on a foundation request is *not* quietened by the
      // filter: the bead it is on isn't, so `quietReasonFor` says so from the same
      // `q.foundation` the card carries, and this call site needs no branch of its own.
      const reason = quietReasonFor(cfg, filter, q);
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
      questions = await app.allQuestions();
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
    const fresh = questions.filter((q) => !notified.has(q.key));

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
      const reason = quietReasonFor(cfg, filter, q);
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
        // Three reasons, three lines. "Somebody else was asked", "filtered out" and
        // "muted right now" are different things to read at 2am when you are working
        // out why the phone stayed dark: one is fixed by pressing All, one by waiting,
        // and one is not yours to fix at all — it is on another engineer's phone,
        // which is the whole of what you want to know before you go back to sleep.
        console.log(
          reason === 'addressed'
            ? `[beadcause] ${q.key} arrived quietly (addressed to ${describeAddressees(q.addressees) || 'somebody else'})`
            : reason === 'filtered'
              ? `[beadcause] ${q.key} arrived quietly (outside the inbox filter: ${describeFilter(filter)})`
              : `[beadcause] ${q.key} arrived quietly (${q.space} is muted right now)`
        );
        // The same two facts, kept for the card rather than for the log — the filter as
        // it stood included, because by the time you read the card it has moved and the
        // one thing you cannot reconstruct is what it was hiding you from.
        hushed[q.key] = quietArrival(reason, q, filter);
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

    await checkReplies(questions.filter((q) => !fresh.includes(q)), filter, rang);

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
    // so it is no longer ringing and no longer something to have declined. Both are
    // pruned here rather than growing until somebody notices the file. Re-read for the
    // reason `rang` exists: the sweep is long enough for the phone to have written.
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
      ringingDeclined: pruneDeclined(current.ringingDeclined, excludedRinging(cfg, stillRinging, filter)),
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
      });
      // Marked before the push, not after: ntfy being unreachable is a reason for one
      // missing notification, not for the same one every thirty seconds forever.
      markAnnounced(rec.id);
      if (rec.status !== 'ok') console.error(`[deploy] ${whereOf(rec)}: ${rec.id} ${rec.status} — ${rec.error || 'no reason recorded'}`);
      else console.log(`[deploy] ${whereOf(rec)}: ${rec.id} ok${rec.to ? ` at ${String(rec.to).slice(0, 8)}` : ''}`);
      try {
        const sent = await pushDeploy(cfg, rec);
        if (sent?.skipped) console.log(`[deploy] ${rec.id} finished (ntfy off — clients poll for it)`);
      } catch (err) {
        console.error(`[deploy] push failed for ${rec.id}: ${err.message}`);
      }
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
    }
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
   * Both pushes are awaited and both failures are swallowed to a log line. ntfy being
   * unreachable is the single most likely thing to be wrong at the moment a *network*
   * sync failed, and a poll cycle that fell over because it could not tell you about a
   * failure would turn one outage into two.
   */
  const sweepSync = async () => {
    if (!syncEnabled(cfg)) return;
    const every = syncEveryMs(cfg);
    if (Date.now() - syncedAt < every) return;
    syncedAt = Date.now();

    const out = await app.syncer.sweep(cfg.workspaces);
    for (const name of out.skipped) console.log(`[sync] ${name}: still syncing from the last tick — skipped`);

    // Nothing is logged for a workspace that synced, or for one with no remote. The
    // whole list would be four lines every two minutes and the fifth — the one that
    // matters — would be the one that scrolls past.
    for (const o of out.changed) {
      const line = `[sync] ${o.workspace}: ${describeSync(o)}`;
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
        phase: o.phase || null,
        detail: describeSync(o),
      });
    }

    // A failure that has *become* a conflict is worth a second push even though it was
    // already failing, because it has stopped being the kind of problem that fixes
    // itself and the first notification said it would retry.
    const broke = out.changed.filter((o) => o.transition === 'broke' || (o.transition === null && o.state === 'conflict'));
    const recovered = out.changed.filter((o) => o.transition === 'recovered');
    try {
      if (broke.length) await pushSyncTrouble(cfg, app.syncer.trouble());
      if (recovered.length) await pushSyncedAgain(cfg, recovered);
    } catch (err) {
      console.error(`[sync] could not push: ${err.message}`);
    }
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
     */
    const epics = (await app.jiraEpics?.sweep(cfg, cfg.workspaces, out.results)) || { filed: [], failed: [] };
    for (const e of epics.filed) {
      const how = e.adopted ? `adopted ${e.id} (${e.adopted})` : `filed ${e.id}`;
      console.log(`[jira] ${e.workspace}: ${e.key} — ${how} as its epic`);
    }
    for (const e of epics.failed) console.error(`[jira] ${e.workspace || ''}: no epic for ${e.key} — ${e.error}`);
    if (epics.filed.length) forgetQueue();

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
    const pending = [];
    for (const r of out.results || []) {
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
  const autoShip = async (ws, queue, { key = '' } = {}) => {
    if (OBSERVING) throw new Error(OBSERVING_NOTE);
    // The repo's key, not the tracker's name: lib/release.js hands it over because the queue
    // it just decided to ship belongs to one checkout of possibly forty in that workspace.
    const which = key || ws.name;
    const already = runningFor(which);
    if (already) throw new Error(`a deploy of ${which} is already running (${already.id})`);
    return beginDeploy(app.bus, cfg, which, {
      bead: queue.prs[queue.prs.length - 1]?.bead || null,
      reason: shipReason(queue),
    });
  };

  const sweepRelease = async () => {
    const every = Math.max(60, Number(cfg.release?.seconds) || 300) * 1000;
    if (Date.now() - sweptReleasesAt < every) return;
    sweptReleasesAt = Date.now();
    const board = await collectBoard(app.bd, cfg);
    if (board.unavailable) return;
    const out = await sweepReleases(app.bd, cfg, board, {
      owner: ownerName(cfg),
      deploys: listDeploys({ limit: 200 }),
      ship: autoShip,
    });
    for (const w of out.watermarked) {
      console.log(
        `[release] ${w.where || w.workspace}: watching from now — ${w.merged} pull request${w.merged === 1 ? '' : 's'} already merged, none filed`
      );
    }
    for (const f of out.filed) console.log(`[release] ${f.where || f.workspace}: filed ${f.bead} for #${f.number} — merged, not live`);
    for (const c of out.closed) console.log(`[release] ${c.where || c.workspace}: closed ${c.bead} — #${c.number} is live`);
    for (const a of out.armed) {
      console.log(
        `[release] ${a.where || a.workspace}: auto-ship armed for #${a.numbers.join(', #')} — one deploy when the settle window closes`
      );
    }
    for (const s of out.shipped) {
      console.log(
        `[release] ${s.where || s.workspace}: auto-shipping ${s.count} merged pull request${s.count === 1 ? '' : 's'} — ${
          s.deploy || 'no record'
        } (${s.why})`
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
      await app.advocates?.tick();
    } catch (err) {
      console.error('[advocate] tick failed:', err.message);
      sweepFailed('the advocate tick', err);
    }
    try {
      await sweepRelease();
    } catch (err) {
      console.error('[release] sweep failed:', err.message);
      sweepFailed('the release sweep', err);
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
      // Last, and the ordering is the argument the others make: this is the only sweep
      // that goes to the network *and* takes Dolt's write lock, so nothing that a phone
      // is waiting on should be behind it. `syncOnce` swallows its own failures into an
      // outcome, so what reaches this catch is a bug rather than a tracker — which is
      // exactly what `sweepFailed` is the bar for.
      await sweepSync();
    } catch (err) {
      console.error('[sync] sweep failed:', err.message);
      sweepFailed('the tracker sync', err);
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
 */
export function listen(cfg, handler) {
  const hosts = ['127.0.0.1'];
  if (cfg.host && cfg.host !== '127.0.0.1') hosts.push(cfg.host);

  // Only asked for when there is an address that would use it. A loopback-only
  // listener — every test, and every backend behind the router — must not shell out
  // to `tailscale` to find that out.
  const material = hosts.length > 1 ? certificate(cfg) : null;
  // Wanted, which is not the same as held: without a certificate the tailnet address is
  // still bound behind the sniffing front, serving plain http until `startRenewal`
  // manages to get one. `tls.enabled: false` is the case where it is not wanted at all.
  const wanted = hosts.length > 1 && tlsEnabled(cfg);

  let bound = 0;
  let failed = 0;
  // One watcher however many times the bind is refused — the error can repeat.
  let watchingTailnet = false;
  const servers = hosts.flatMap((host) => {
    const onTailnet = host !== '127.0.0.1';
    const { server, front, plain } =
      onTailnet && wanted ? tailnetServer(material, handler) : { server: http.createServer(handler), front: null, plain: null };
    // The front owns the port when there is one, so it is the one that fails to bind
    // and the one that has to be closed. `tailnetServer` has already hung it on both
    // servers as `.front` for `closeServer` to find.
    const listener = front || server;
    listener.on('error', (err) => {
      console.error(`[beadcause] listen ${host}:${cfg.port} — ${err.message}`);
      // Bind failure on every address means another instance owns the port. Die,
      // rather than lingering as a listener-less process whose poller still fires
      // pushes — launchd's KeepAlive can't see that, and two pollers double-notify.
      //
      // `PORT_TAKEN_EXIT` and not 1, because this process is usually a *backend* and its
      // parent router cannot read this log: stdio is inherited, so both of them write to
      // the same launchd file and neither reads it. The exit code is the only sentence
      // the router gets, and "the port was taken" has to be distinguishable from "the
      // build is broken" — the router retries the first on a fresh port and condemns the
      // build for the second. lib/startup.js says why that difference is the bead.
      if (++failed === hosts.length && bound === 0) {
        console.error('[beadcause] no address could be bound — exiting');
        process.exit(PORT_TAKEN_EXIT);
      }
      // A tailnet address that is not on this Mac is not the failure above — loopback
      // has bound, something is being served, and there is nothing to exit over. It is
      // also not nothing, which is what it used to be: bc-b4fs is a morning spent on a
      // daemon that reported itself healthy while the phone could not reach it, and the
      // only trace was the `EADDRNOTAVAIL` line above. Say which of the causes it is.
      //
      // Unlike bin/router.js, this does not re-bind the address when it appears — it
      // says that a restart will. The sockets here are threaded through
      // `attachTerminalSocket` and `startRenewal` by bin/beadcause.js, and re-running
      // those around a late arrival is the router's job in the installed configuration,
      // where the router is what holds the tailnet address anyway. This path is
      // `npm run start:bare`. See bc-b4fs.1.
      if (onTailnet && err.code === 'EADDRNOTAVAIL' && !watchingTailnet) {
        watchingTailnet = true;
        console.error(`[beadcause] tailnet     ${tailnetLine(host)}`);
        watchForAddress(host, () => {
          console.error(`[beadcause] tailnet     ${host} is on this Mac now — restart to bind it (\`npm run start:bare\`)`);
        });
      }
    });
    listener.listen(cfg.port, host, () => {
      bound++;
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
  });
  boundServers = servers;
  return servers;
}
