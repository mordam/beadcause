import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bd } from './bd.js';
import { endorse } from './endorse.js';
import {
  applyVerdict,
  normalizeEdits,
  parseIds,
  statusFor,
  verdictBody,
  EDITABLE,
  MAX_IDS,
  REVOKED_PREFIX,
  REVOKED_REASON,
} from './verdict.js';
import { endorsementQueue, forget as forgetQueue } from './endorsequeue.js';
import { toQuestion, optionById } from './decision.js';
import { parseGraph, enrichGraph, movedSince } from './graph.js';
import { collectWork, shortActor } from './work.js';
import { liveSessions } from './claude.js';
import { tailTranscript } from './transcript.js';
import { pushQuestion, pushReply, pushFoundationRequest, pushFoundationReply, pushDeploy } from './notify.js';
import { loadState, saveState, saveConfig, CONFIG_PATH, OBSERVING, OBSERVING_NOTE } from './config.js';
import { publicRoster, addAgent, removeAgent, agentFor, acknowledged, acknowledge, withAgentNames } from './agents.js';
import { createEventBus } from './events.js';
import {
  messageSession,
  openSession,
  openShipSession,
  resolveSessionDir,
  sessionReach,
  terminalPrompt,
} from './session.js';
import { collectBoard, forgetBoard, landLocally } from './prboard.js';
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
import { readArchive, readArchived } from './sessionlog.js';
import { dispatchReply, agentBusyOn, busyAgents } from './dispatch.js';
import { createAdvocates, PROPOSAL_LABEL } from './advocate.js';
import { createAdmin } from './admin.js';
import { deployFor, deployHint, deployable, startDeploy, listDeploys, showDeploy, briefDeploy, deployLog, runningFor, sweepDeploys, unannounced, markAnnounced } from './deploy.js';
import { parseProposal, isApproval, parseApproval, applyEdits, dupeNote } from './proposal.js';
import { findDuplicate, liveCandidates } from './dupe.js';
import { resolveAmendment, AMENDMENT_LABEL } from './amendment.js';
import { deliveryAction, parseDelivery, DELIVERY_LABEL } from './delivery.js';
import { oweClose, sweepOwed } from './owed.js';
import { ownerName } from './owner.js';
import { certificate, secureServer, MIN_VERSION } from './tls.js';
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
import { spaceFor, summarise, reconcileFilter, quietReasonFor, describeFilter } from './spaces.js';
import { dismissAsk, drop, excludedRinging, pruneDeclined, rangFor, retain as retainRinging } from './ringing.js';
import { recordAnswer, answeredBefore, answeredAgo, pruneAnswered } from './answered.js';
import { readAll as readActivity, activityFor, setActivity, clearActivity, pruneActivity } from './activity.js';
import * as presence from './presence.js';

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
  const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer });
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
    const answers = loadState().answered;
    const results = await Promise.all(
      cfg.workspaces.map(async (ws) => {
        try {
          const rows = await bd.listHuman(ws);
          return rows.map((r) => {
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
            return q;
          });
        } catch (err) {
          console.error(`[beadcause] ${ws.name}: ${err.message.split('\n')[0]}`);
          return [];
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
    spacesPending = summarise(cfg, inbox);
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
          return rows.map((r) => {
            const q = toQuestion(ws.name, r);
            q.activity = activityFor(q.key, r.labels, store);
            q.awaitingAgent = (r.labels || []).includes(REPLIED_LABEL);
            q.space = spaceFor(cfg, ws.name)?.name || null;
            q.foundation = true;
            return q;
          });
        } catch (err) {
          console.error(`[beadcause] ${ws.name}: ${err.message.split('\n')[0]}`);
          return [];
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
          return rows.map((r) => {
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
        } catch (err) {
          console.error(`[beadcause] ${ws.name}: ${err.message.split('\n')[0]}`);
          return [];
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
  async function createProposed(ws, id, response, picked, edits) {
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
    try {
      for (const bead of toCreate) {
        const newId = await bd.create(ws, {
          title: bead.title,
          body: bead.description,
          type: bead.type,
          priority: bead.priority,
          acceptance: bead.acceptance,
          design: bead.design,
          notes: bead.notes,
          deps: bead.deps,
          // `advocate` marks provenance: these were proposed by an agent and
          // approved by you, which is worth being able to search for later.
          labels: ['advocate', ...bead.labels],
        });
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
  async function finishWorkBead(ws, workId, questionId, reason) {
    await bd.dropDep(ws, workId, questionId).catch((err) => {
      // Not fatal, and often not even wrong: a delivery whose `dep add` failed, or a
      // hand-filed card, never had the edge. The gate below is what decides.
      console.error(`[pr] ${ws.name}: could not drop ${workId} → ${questionId} — ${err.message.split('\n')[0]}`);
    });

    const gate = await bd.closeGate(ws, workId);
    if (!gate) {
      try {
        await bd.close(ws, workId, reason);
        return { closed: true, why: '' };
      } catch (err) {
        const why = String(err.message || err).split('\n')[0];
        console.error(`[pr] ${ws.name}: could not close ${workId} — ${why}`);
        oweClose({ workspace: ws.name, id: workId, reason, why });
        return { closed: false, why };
      }
    }
    console.log(`[pr] ${ws.name}: ${workId} cannot close yet — ${gate.reason}; owed until it can`);
    oweClose({ workspace: ws.name, id: workId, reason, why: gate.reason });
    return { closed: false, why: gate.reason };
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
  async function resolveDeliveryFor(ws, id, response) {
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

    let dir;
    try {
      dir = resolveSessionDir(cfg, ws);
    } catch (err) {
      throw Object.assign(new Error(`no checkout for ${ws.name}: ${err.message}`), { status: 409 });
    }

    if (act.action === 'merge' || act.action === 'ship') {
      const merged = await pr.merge(dir, d.number, { method: d.method, deleteBranch: true });
      const landed = merged.mergeCommit ? ` as ${merged.mergeCommit.slice(0, 8)}` : '';
      const was = merged.alreadyMerged ? 'was already merged' : `merged${landed}`;
      // The work bead, not the question. Closing it here is what makes the merge the
      // end of the work rather than a step in it — and the reason names the PR,
      // because six months on the number is the only way back to the diff.
      const finished = d.bead && d.bead !== id ? await finishWorkBead(ws, d.bead, id, `Merged #${d.number}${landed} into ${d.base}`) : null;
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
      let why = '';
      let plan = null;
      try {
        plan = deployFor(cfg, ws.name);
        if (!plan) why = `no deploy is declared for ${ws.name} — see \`deploys\` in ${CONFIG_PATH}`;
      } catch (err) {
        // A declaration that is present and malformed. Named on the card, because the
        // only person who can fix it is the one reading this.
        why = `${ws.name} declares a deploy this cannot read — ${err.message}`;
      }
      const already = plan && !why ? runningFor(ws.name) : null;
      if (already) why = `a deploy of ${ws.name} is already running (${already.id})`;

      if (why) {
        console.error(`[pr] ${ws.name}: merged #${d.number} but will not deploy — ${why}`);
        return { note: `${note} **Not deployed:** ${why}.`, result: { action: 'ship', pr: merged, deploy: null }, deploy: null };
      }
      return {
        note: `${note} Deploying ${ws.name} now — how it went lands on the PR board and on your phone.`,
        result: { action: 'ship', pr: merged, deploy: null },
        deploy: { workspace: ws.name, bead: d.bead || null, reason: `Shipped #${d.number}${landed} from ${id}` },
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
        await bd.comment(ws, d.bead, `## Changes requested on #${d.number}\n\n${note}\n\nThe branch \`${d.branch}\` is still open — push to it, do not start a new one.`);
        await bd.reopen(ws, d.bead).catch((err) => console.error(`[pr] ${ws.name}: could not reopen ${d.bead} — ${err.message}`));
      }
      console.log(`[pr] ${ws.name}: changes requested on #${d.number} — ${d.bead || '(no bead)'} back in the queue`);
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
        ].join('\n')
      );
      await bd.reopen(ws, d.bead).catch((err) => console.error(`[pr] ${ws.name}: could not reopen ${d.bead} — ${err.message}`));
    }
    console.log(`[pr] ${ws.name}: declined #${d.number}${why ? ' with direction' : ' with no direction given'}`);
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
  async function prBoardRow(ws, number, { force = false } = {}) {
    if (!Number.isInteger(number) || number <= 0) {
      throw Object.assign(new Error('a pull request number is required'), { status: 400 });
    }
    const board = await collectBoard(bd, cfg, { force });
    if (board.unavailable) throw Object.assign(new Error(board.unavailable), { status: 409 });
    const card = board.repos.find((r) => r.workspace === ws.name);
    if (card?.error) throw Object.assign(new Error(card.error), { status: 409 });
    const row = (card?.prs || []).find((r) => r.number === number);
    if (!row) throw Object.assign(new Error(`no pull request #${number} on the ${ws.name} board`), { status: 404 });
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
   * Only what a *person says* is attributed: the answer, the comment, the dismissal
   * note. What the daemon does around those — labels, statuses, the beads a "yes"
   * creates, the notes a merge leaves on a work bead — stays `beadcause`, because
   * those are the daemon's record of its own actions and `owner` on a created bead is
   * read as a queue rather than as a byline.
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
    // The chat session, with or without an id in the query.
    if (urlPath === '/console') urlPath = '/console.html';
    // The PR board. `/pulls` too, because GitHub calls that tab Pull requests and
    // half the time that is the word you will reach for.
    if (urlPath === '/prs' || urlPath === '/pulls') urlPath = '/prs.html';
    // The endorsement queue — the beads an agent filed that nobody has looked at yet.
    // Three paths because the screen has two honest names: it is the place you
    // *endorse* things, and it is the *queue* of what is waiting, and which word comes
    // to mind depends on whether you arrived from a notification or went looking.
    if (urlPath === '/endorse' || urlPath === '/queue' || urlPath === '/endorsements') {
      urlPath = '/endorse.html';
    }
    if (urlPath === '/foundations') urlPath = '/foundations.html';
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
        const spaces = summarise(cfg, rows);
        const savedState = loadState();
        const savedFilter = reconcileFilter(spaces, [...workspaces.keys()], savedState.filter);
        return json(res, 200, {
          questions: rows,
          // Its own field, never folded into `questions`. A client that does not know
          // about the channel shows the inbox exactly as it did before and simply
          // does not draw the requests — which is the right failure: an old Android
          // build showing a constitutional decision as one more work question is
          // worse than it showing none.
          requests: scope === 'agent' ? agentScopeRequests : requests,
          workspaces: [...workspaces.keys()],
          // Counted over what was actually asked for, which is the whole point:
          // the space chip now says how many beads are live in it, not just how
          // many are asking you something. Requests are out of it for the same
          // reason they are out of the list: they are not work in a space.
          spaces,
          // Carried on the payload the inbox already waits for, rather than fetched
          // separately, so the first render is the filtered one. A second round trip
          // would paint the whole unfiltered list first and then snatch it away.
          //
          // Reconciled on the way out rather than on the way in, because what makes a
          // saved filter stale is the config changing underneath it — which happens
          // while nobody is writing anything at all. See reconcileFilter.
          filter: savedFilter,
          // On the same payload as the filter, and for a reason that is not symmetry:
          // the prompt belongs on the inbox at the moment the filter changed, and the
          // POST that changed it may not be the request that repaints. A laptop that
          // narrowed the filter moves the phone's chips on its next poll, so the phone
          // is where the ask has to be able to appear. Null means "say nothing" —
          // which is also what an old client reads it as.
          dismissAsk: askFor(savedFilter, savedState),
          // Additive, and its own object so it stays that way. A client that has never
          // heard of it — the installed Android build, a service worker still serving
          // last week's app.js — reads the fields it knows and renders exactly as it
          // did. Anything that needs more than these three counts wants /api/work.
          summary: summaryNow(),
          scope,
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
          const dir = resolveSessionDir(cfg, ws);
          return json(res, 200, { delivery: d, pr: await pr.view(dir, d.number), unavailable: null });
        } catch (err) {
          return json(res, 200, { delivery: d, pr: null, unavailable: err.message });
        }
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
        return json(res, 200, { ...board, observing: OBSERVING });
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
       */
      if (p === '/api/pr/merge' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const row = await prBoardRow(ws, Number(body.number), { force: true });
        const dir = resolveSessionDir(cfg, ws);
        const merged = await pr.merge(dir, row.number, { method: body.method || cfg.pr?.mergeMethod || 'merge' });
        const land = await landLocally(dir, row.base || cfg.pr?.base || 'main');
        // The sweep this came from is now wrong about the one row anyone is looking at.
        forgetBoard();
        console.log(
          `[beadcause] merged ${ws.name} #${row.number}${merged.alreadyMerged ? ' (already merged)' : ''} — ${land.note}`
        );
        /*
         * No `bus.emit` here, and the emit that was here is gone deliberately.
         *
         * It sent `pr-merged`, and nothing has ever read it: no page, no script, and not
         * the Android watch service, which is the one client that parks on `/api/poll`
         * across a merge. What it *did* do was cost something. `changed` in the poll
         * handler is `events.some((e) => e.type !== 'presence')`, so any event but
         * presence makes the daemon sweep `bd` across every workspace and hand the result
         * to every parked client — and a merge on GitHub changes no bead here, so the
         * sweep came back with the list it already had. One full multi-workspace sweep,
         * per merge, to tell everyone nothing.
         *
         * The event a merge from this board *should* cause is a real one and is not this:
         * merging #N leaves the inbox's own "Merge #N?" card open, because nothing in
         * this handler writes to the tracker. That is a behaviour change with a decision
         * in it — whether a board merge answers a question you never answered — so it is
         * proposed as its own bead rather than smuggled in under a housekeeping sweep.
         */
        return json(res, 200, { ok: true, pr: merged, alreadyMerged: Boolean(merged.alreadyMerged), land });
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
        const ws = requireWorkspace(body.workspace);
        const row = await prBoardRow(ws, Number(body.number), { force: true });
        if (!row.merged) {
          return json(res, 409, { error: `#${row.number} is not merged yet — there is nothing to ship` });
        }

        // Asked again rather than trusted from the board: the row may be up to 25
        // seconds old, and a declaration that cannot be read must fail here — with the
        // parse error in it — rather than quietly falling back to a window, which
        // would answer a typo by opening something you then have to close.
        let plan;
        try {
          plan = deployFor(cfg, ws.name);
        } catch (err) {
          throw Object.assign(new Error(`${ws.name} declares a deploy this cannot read — ${err.message}`), { status: 409 });
        }
        if (plan) {
          const already = runningFor(ws.name);
          if (already) {
            return json(res, 409, { error: `a deploy of ${ws.name} is already running`, deploy: already });
          }
          const bead = (row.beads || [])[0]?.id || null;
          const rec = startDeploy(cfg, ws.name, {
            bead,
            reason: `Shipped #${row.number}${row.mergeCommit ? ` (${row.mergeCommit.slice(0, 8)})` : ''} from the PR board`,
          });
          console.log(
            `[deploy] ${ws.name}: started ${rec.id} (pid ${rec.pid}) for #${row.number}${rec.restarts ? ' — this one restarts beadcause' : ''}`
          );
          return json(res, 200, { ok: true, via: 'deploy', deploy: rec, hint: deployHint(plan), number: row.number });
        }

        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });
        const opened = await openShipSession(cfg, ws, row);
        console.log(`[beadcause] ship session for ${ws.name} #${row.number} in ${opened.dir} (${opened.mode})`);
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
        const ws = requireWorkspace(body.workspace);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'text is required' });
        const row = await prBoardRow(ws, Number(body.number));
        await pr.comment(resolveSessionDir(cfg, ws), row.number, text);
        console.log(`[beadcause] commented on ${ws.name} #${row.number}`);
        return json(res, 200, { ok: true, number: row.number });
      }

      if (p === '/api/respond' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        if (!body.id || !String(body.response || '').trim()) {
          return json(res, 400, { error: 'id and response are required' });
        }
        const response = String(body.response);
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
          body.edits && typeof body.edits === 'object' ? body.edits : null
        );
        // The other question whose answer writes something: an agent asking to change
        // what it is. Before the close for the same reason as the create above — a
        // commit that fails must leave the question answerable rather than closed on
        // a promise nothing kept.
        const amended = await resolveAmendmentFor(ws, body.id, response);
        // And the third: a worker's pull request, whose answer is the merge. Same
        // placement and the same reason — a merge GitHub refuses must leave the
        // question open, because a closed question is one you cannot answer again.
        const delivered = await resolveDeliveryFor(ws, body.id, response);

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
        // Whose answer this is. Null for a token caller, which is every caller that
        // has ever answered from a notification shade — see `actorFor`.
        const who = actorFor(req);
        if (commission) await bd.commission(ws, body.id, answer, { actor: who });
        else await bd.respond(ws, body.id, answer, { actor: who });
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
            deploy = startDeploy(cfg, delivered.deploy.workspace, {
              bead: delivered.deploy.bead,
              reason: delivered.deploy.reason,
            });
            console.log(
              `[deploy] ${deploy.workspace}: started ${deploy.id} (pid ${deploy.pid}) from ${ws.name}/${body.id}` +
                `${deploy.restarts ? ' — this one restarts beadcause' : ''}`
            );
          } catch (err) {
            console.error(`[deploy] ${delivered.deploy.workspace}: ship answered but no deploy started — ${err.message}`);
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
          filter: reconcileFilter(spaces, names, saved.filter),
          // What the inbox's own chip says, so a picker drawn beside it on a page that
          // has no inbox can still say how much is waiting in total.
          waiting: questionsPending,
        });
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
            questions: fresh?.questions ?? null,
            requests: fresh?.requests ?? null,
            spaces: fresh ? summarise(cfg, fresh.questions) : null,
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
          questions: polled?.questions ?? null,
          // Null rather than [] when nothing moved, exactly like `questions`: an
          // empty array means "the channel is empty", and a poll that timed out
          // never asked. A watcher that confused the two would clear the pane on
          // every quiet minute.
          requests: polled?.requests ?? null,
          spaces: polled ? summarise(cfg, polled.questions) : null,
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

        const { dir, mode } = await openSession(cfg, ws, id, q.question || q.title);
        console.log(`[beadcause] opened a session on ${ws.name}/${id} in ${dir} (permission mode: ${mode})`);
        return json(res, 200, { ok: true, dir, mode, endorsed });
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
          bead = { id: seedId, title: q.question || q.title || '' };
        }

        const t = openTerminal(cfg, ws, {
          bead,
          prompt: terminalPrompt(ws.name, bead?.id || null, bead?.title || ''),
          cols: body.cols,
          rows: body.rows,
        });
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
        const id = await bd.create(ws, {
          title,
          body: String(body.body || ''),
          priority: body.priority ?? 1,
        });
        if (!id) return json(res, 502, { error: 'bd created the issue but returned no id' });
        // You filed this yourself thirty seconds ago — don't push it back at you.
        hooks.suppressPush?.(`${ws.name}/${id}`);
        console.log(`[beadcause] filed ${ws.name}/${id} — ${title}`);
        bus.emit({ type: 'created', key: `${ws.name}/${id}`, workspace: ws.name, id });
        return json(res, 200, { ok: true, id, key: `${ws.name}/${id}` });
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
          seed = { id: issue.id, title: issue.title || '' };
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
        if (seed) await sendTurn(cfg, c, '');
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
        await sendTurn(cfg, c, String(body.text));
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

      /** The cards as you edited them. Re-normalised, so the editor can't widen the schema. */
      if (p === '/api/console/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const c = getConsole(body.id);
        if (!c) return json(res, 404, { error: 'no such chat session' });
        setDraft(c, body.draft ? normalizeDraft(body.draft) : null);
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
            const id = await bd.create(ws, {
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
            });
            if (!id) throw new Error(`bd created "${b.title}" but returned no id`);
            ids.set(b.ref, id);
            created.push({ ref: b.ref, id, title: b.title });
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
       */
      if (p === '/api/advocate' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.workspace || '');
        if (!advocates.has(name)) return json(res, 404, { error: `no advocate for ${name || '(none given)'}` });
        await advocates.control(name, String(body.action || ''), body.value);
        return json(res, 200, { ok: true, advocates: advocates.snapshot() });
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
        const ws = requireWorkspace(body.workspace);
        if (!deployFor(cfg, ws.name)) {
          return json(res, 409, { error: `no deploy is declared for ${ws.name} — see \`deploys\` in ${CONFIG_PATH}` });
        }
        const already = runningFor(ws.name);
        if (already) return json(res, 409, { error: `a deploy of ${ws.name} is already running`, deploy: already });
        const rec = startDeploy(cfg, ws.name, { bead: body.bead || null, reason: String(body.reason || '') });
        console.log(`[deploy] ${ws.name}: started ${rec.id} (pid ${rec.pid})${rec.restarts ? ' — this one restarts beadcause' : ''}`);
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
        return json(res, 200, { ...issue, workspace: ws.name, comments: await bd.comments(ws, id) });
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
       * to: `file` is restricted to the three names the archive itself writes, so a
       * crafted value cannot walk into arbitrary tree content.
       */
      if (p === '/api/session-archive' && req.method === 'GET') {
        const ws = requireWorkspace(url.searchParams.get('workspace'));
        const dir = resolveSessionDir(cfg, ws);
        const commit = String(url.searchParams.get('commit') || '');

        if (commit) {
          if (!/^[0-9a-f]{7,40}$/i.test(commit)) return json(res, 400, { error: 'not a commit id' });
          const file = String(url.searchParams.get('file') || 'session.log');
          if (!['session.log', 'meta.json', 'transcript.jsonl'].includes(file)) {
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
       */
      if (p === '/api/session-log' && req.method === 'GET') {
        const pid = Number(url.searchParams.get('pid'));
        // Re-read rather than cache: `/clear` rewrites the record with a new session
        // id, and the pane must follow the conversation the process is actually on.
        const session = liveSessions(cfg).find((s) => s.pid === pid);
        if (!session) return json(res, 404, { error: `no session running as pid ${pid || '(none given)'}` });
        const { file, lines } = tailTranscript(cfg, session);
        return json(res, 200, {
          ...session,
          // Where it looked, so an empty pane can say why it is empty.
          file,
          lines,
          reach: await sessionReach(pid),
        });
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

  return { handler, allQuestions, foundationRequests, splitChannels, bd, hooks, bus, advocates };
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
      return console.error('[beadcause] poll failed:', err.message);
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
        // Two reasons, two lines. "Filtered out" and "muted right now" are different
        // things to read at 2am when you are working out why the phone stayed dark,
        // and one of them is fixed by pressing All rather than by waiting.
        console.log(
          reason === 'filtered'
            ? `[beadcause] ${q.key} arrived quietly (outside the inbox filter: ${describeFilter(filter)})`
            : `[beadcause] ${q.key} arrived quietly (${q.space} is muted right now)`
        );
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
    }

    await checkReplies(questions.filter((q) => !fresh.includes(q)), filter, rang);

    // Answered somewhere other than here (an agent closed it, or `bd close` on the
    // Mac). Clients holding a notification for it need to drop it.
    for (const key of notified) if (!live.has(key)) app.bus.emit({ type: 'answered', key });

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
    saveState({
      notified: [...notified],
      commentCounts: counts,
      ringing: stillRinging,
      ringingDeclined: pruneDeclined(current.ringingDeclined, excludedRinging(cfg, stillRinging, filter)),
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
      console.log(`[deploy] ${rec.workspace}: ${rec.id} → ${rec.status} — ${rec.error}`);
    }
    for (const rec of unannounced()) {
      app.bus.emit({ type: 'deploy', workspace: rec.workspace, id: rec.id, status: rec.status, bead: rec.bead || null });
      // Marked before the push, not after: ntfy being unreachable is a reason for one
      // missing notification, not for the same one every thirty seconds forever.
      markAnnounced(rec.id);
      if (rec.status !== 'ok') console.error(`[deploy] ${rec.workspace}: ${rec.id} ${rec.status} — ${rec.error || 'no reason recorded'}`);
      else console.log(`[deploy] ${rec.workspace}: ${rec.id} ok${rec.to ? ` at ${String(rec.to).slice(0, 8)}` : ''}`);
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

  const cycle = async () => {
    await tick();
    try {
      // Before the advocates and after the pushes, for the same reason the advocates
      // are where they are: this reads a directory and may send one notification, and
      // nothing about it should be able to delay a question reaching the phone.
      await settleDeploys();
    } catch (err) {
      console.error('[deploy] sweep failed:', err.message);
    }
    try {
      await retryOwedCloses();
    } catch (err) {
      console.error('[pr] owed-close sweep failed:', err.message);
    }
    try {
      await app.advocates?.tick();
    } catch (err) {
      console.error('[advocate] tick failed:', err.message);
    }
  };

  cycle();
  return setInterval(cycle, Math.max(5, cfg.pollSeconds || 30) * 1000);
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
 * `closeServer`.
 */
export function listen(cfg, handler) {
  const hosts = ['127.0.0.1'];
  if (cfg.host && cfg.host !== '127.0.0.1') hosts.push(cfg.host);

  // Only asked for when there is an address that would use it. A loopback-only
  // listener — every test, and every backend behind the router — must not shell out
  // to `tailscale` to find that out.
  const material = hosts.length > 1 ? certificate(cfg) : null;

  let bound = 0;
  let failed = 0;
  const servers = hosts.map((host) => {
    const secure = Boolean(material) && host !== '127.0.0.1';
    const { server, front } = secure ? secureServer(material, handler) : { server: http.createServer(handler), front: null };
    // The front owns the port when there is one, so it is the one that fails to bind
    // and the one that has to be closed. `secureServer` has already hung it on the
    // server as `.front` for `closeServer` to find.
    const listener = front || server;
    listener.on('error', (err) => {
      console.error(`[beadcause] listen ${host}:${cfg.port} — ${err.message}`);
      // Bind failure on every address means another instance owns the port. Die,
      // rather than lingering as a listener-less process whose poller still fires
      // pushes — launchd's KeepAlive can't see that, and two pollers double-notify.
      if (++failed === hosts.length && bound === 0) {
        console.error('[beadcause] no address could be bound — exiting');
        process.exit(1);
      }
    });
    listener.listen(cfg.port, host, () => {
      bound++;
      if (secure) console.log(`[beadcause] listening on https://${material.name}:${cfg.port} (${host}, ${MIN_VERSION} floor)`);
      else console.log(`[beadcause] listening on http://${host}:${cfg.port}`);
    });
    return server;
  });
  return servers;
}
