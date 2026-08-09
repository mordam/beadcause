import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bd } from './bd.js';
import { toQuestion } from './decision.js';
import { parseGraph, enrichGraph, movedSince } from './graph.js';
import { collectWork, shortActor } from './work.js';
import { liveSessions } from './claude.js';
import { tailTranscript } from './transcript.js';
import { pushQuestion, pushReply, pushFoundationRequest, pushFoundationReply } from './notify.js';
import { loadState, saveState, saveConfig, CONFIG_PATH, OBSERVING, OBSERVING_NOTE } from './config.js';
import { publicRoster, addAgent, removeAgent, agentFor, acknowledged, acknowledge } from './agents.js';
import { createEventBus } from './events.js';
import { openSession, openShipSession, resolveSessionDir, terminalPrompt } from './session.js';
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
import { parseProposal, isApproval, parseApproval, applyEdits } from './proposal.js';
import { resolveAmendment, AMENDMENT_LABEL } from './amendment.js';
import { deliveryAction, parseDelivery, DELIVERY_LABEL } from './delivery.js';
import { ownerName } from './owner.js';
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
import { spaceFor, isQuiet, summarise } from './spaces.js';
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

  /** Every open human-labelled issue, across every workspace. */
  async function allQuestions() {
    const store = readActivity();
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
            return q;
          });
        } catch (err) {
          console.error(`[beadcause] ${ws.name}: ${err.message.split('\n')[0]}`);
          return [];
        }
      })
    );
    const rows = results
      .flat()
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || String(a.createdAt).localeCompare(String(b.createdAt)));
    // Counted by workspace rather than by row: `propose()` allows one open ask per
    // advocate, so the two agree in practice, and where they disagree — a second
    // proposal-shaped bead written by hand — one advocate waiting is the true answer.
    proposalsPending = new Set(rows.filter((q) => q.proposal).map((q) => q.workspace)).size;
    // The inbox's own count, taken here so it is whatever the last sweep saw rather
    // than whatever this request asked for. An advocate's ask is one of these too:
    // it arrives as an ordinary question and is answered like one, so leaving it out
    // would put a card on screen that the number above it denies.
    questionsPending = splitChannels(rows).questions.length;
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
    const none = { created: [], declined: [] };
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

    const created = [];
    try {
      for (const bead of chosen) {
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
        `${created.length ? ` — ${created.join(', ')}` : ''}`
    );
    return { created, declined };
  }

  /**
   * Merge what a worker built — and nothing else, ever.
   *
   * The third answer that writes something, and the only one that writes outside
   * this Mac. A worker no longer merges its own work: it pushes a branch, opens a
   * pull request, and files a question carrying the PR's identity in a `beadpr`
   * block. This is what turns the tap on that question into the merge.
   *
   * Three answers, all of them recorded:
   *
   * - **Merge.** `gh pr merge`, then close the *work* bead with the PR number in
   *   its reason. Two beads move: the question closes because it was answered, and
   *   the work closes because it landed. Deliberately in that order — if the merge
   *   fails, the question stays open and answerable rather than closed on a promise
   *   nothing kept, which is the same discipline `createProposed` keeps.
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
   */
  async function resolveDeliveryFor(ws, id, response) {
    const none = { note: '', result: null };
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

    if (act.action === 'merge') {
      const merged = await pr.merge(dir, d.number, { method: d.method, deleteBranch: true });
      const landed = merged.mergeCommit ? ` as ${merged.mergeCommit.slice(0, 8)}` : '';
      const was = merged.alreadyMerged ? 'was already merged' : `merged${landed}`;
      // The work bead, not the question. Closing it here is what makes the merge the
      // end of the work rather than a step in it — and the reason names the PR,
      // because six months on the number is the only way back to the diff.
      if (d.bead && d.bead !== id) {
        await bd
          .close(ws, d.bead, `Merged #${d.number}${landed} into ${d.base}`)
          .catch((err) => console.error(`[pr] ${ws.name}: merged #${d.number} but could not close ${d.bead} — ${err.message}`));
      }
      console.log(`[pr] ${ws.name}: #${d.number} ${was} → ${d.base}, closed ${d.bead || '(no bead)'}`);
      bus.emit({ type: 'merged', key: `${ws.name}/${id}`, workspace: ws.name, id, bead: d.bead, number: d.number });
      return { note: `Merged #${d.number}${landed}${d.bead ? ` — closed ${d.bead}` : ''}.`, result: { action: 'merge', pr: merged } };
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
      return { note: `Changes requested on #${d.number} — ${d.bead || 'the work'} is back in the queue.`, result: { action: 'changes' } };
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

  async function serveStatic(res, urlPath) {
    // /doc?p=… is the reader tab. It's a static page: it pulls the token from
    // localStorage and fetches the file itself, so no token rides in the URL.
    if (urlPath === '/doc') urlPath = '/doc.html';
    if (urlPath === '/graph') urlPath = '/graph.html';
    // `/sessions` is what the view is called now. `/work` is kept because it is on
    // the phone's home screen and in the Android shell's history, and a bookmark that
    // 404s is a worse outcome than two paths for one page.
    if (urlPath === '/work' || urlPath === '/sessions') urlPath = '/work.html';
    // The chat session, with or without an id in the query.
    if (urlPath === '/console') urlPath = '/console.html';
    // The PR board. `/pulls` too, because GitHub calls that tab Pull requests and
    // half the time that is the word you will reach for.
    if (urlPath === '/prs' || urlPath === '/pulls') urlPath = '/prs.html';
    if (urlPath === '/foundations') urlPath = '/foundations.html';
    // The in-app terminal, with or without a terminal id in the query.
    if (urlPath === '/terminal') urlPath = '/term.html';
    // The advocate console — what bin/monitor.js showed in one line per repo, in
    // full. `/advocates` too, because two people will guess two different names for
    // it and the LaunchAgent only ever opens one of them.
    if (urlPath === '/monitor' || urlPath === '/advocates') urlPath = '/monitor.html';
    // Pause all / resume all. Its own page rather than a block on /sessions: it is
    // the one control here that stops everything at once, and a screen you visit
    // constantly is the wrong place to keep a button like that.
    if (urlPath === '/admin') urlPath = '/admin.html';
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
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

    if (!p.startsWith('/api/')) return serveStatic(res, p);

    if (p === '/api/health') return json(res, 200, { ok: true, workspaces: [...workspaces.keys()] });

    const supplied = req.headers['x-beadcause-token'] || url.searchParams.get('t');
    if (!timingSafeEqual(supplied, cfg.token)) return json(res, 401, { error: 'bad or missing token' });

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
          spaces: summarise(cfg, rows),
          // Carried on the payload the inbox already waits for, rather than fetched
          // separately, so the first render is the filtered one. A second round trip
          // would paint the whole unfiltered list first and then snatch it away.
          filter: loadState().filter,
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
        const merged = await pr.merge(dir, row.number, { method: body.method || 'squash' });
        const land = await landLocally(dir, row.base || cfg.pr?.base || 'main');
        // The sweep this came from is now wrong about the one row anyone is looking at.
        forgetBoard();
        console.log(
          `[beadcause] merged ${ws.name} #${row.number}${merged.alreadyMerged ? ' (already merged)' : ''} — ${land.note}`
        );
        bus.emit({ type: 'pr-merged', key: `${ws.name}#${row.number}`, workspace: ws.name, number: row.number });
        return json(res, 200, { ok: true, pr: merged, alreadyMerged: Boolean(merged.alreadyMerged), land });
      }

      /**
       * Ship it — the one button that is a window on the Mac rather than an act here.
       *
       * A deploy is repo-specific and lives in that repo's CLAUDE.md, which is why
       * this hands the job to a session rather than running anything: see
       * `openShipSession` in lib/session.js for the brief it opens with.
       *
       * Refused before it starts if the PR is not merged. Shipping an unmerged pull
       * request has no meaning, and a window that opens and then explains that to
       * itself is a window you have to go and close.
       */
      if (p === '/api/pr/ship' && req.method === 'POST') {
        if (cfg.openSessions === false) return json(res, 403, { error: 'openSessions is disabled in config' });
        // Same refusal as `/api/session`, and for the stronger version of the same
        // reason: an observer would open an unattended session that deploys a checkout
        // it is only visiting.
        if (OBSERVING) return json(res, 403, { error: OBSERVING_NOTE });
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        const row = await prBoardRow(ws, Number(body.number), { force: true });
        if (!row.merged) {
          return json(res, 409, { error: `#${row.number} is not merged yet — there is nothing to ship` });
        }
        const opened = await openShipSession(cfg, ws, row);
        console.log(`[beadcause] ship session for ${ws.name} #${row.number} in ${opened.dir} (${opened.mode})`);
        return json(res, 200, { ok: true, ...opened, number: row.number });
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
        const gate = await bd.closeGate(ws, body.id);
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
        const { created, declined } = await createProposed(
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
          amended.note,
          delivered.note,
        ].filter(Boolean);
        await bd.respond(ws, body.id, record.length ? `${response}\n\n${record.join('\n')}` : response);
        console.log(`[beadcause] answered ${ws.name}/${body.id}`);
        // Tell every other client the card is gone before the poller notices, so
        // answering on the phone clears the notification on the tablet.
        bus.emit({ type: 'answered', key: `${ws.name}/${body.id}`, workspace: ws.name, id: body.id });
        // The delivery question closes on every one of its three answers, including
        // "request changes" — the question was *merge this?* and it has been
        // answered. The next push files a new one, so the inbox carries one card per
        // attempt rather than one card that quietly changes meaning under you.
        return json(res, 200, { ok: true, closed: true, created, declined, amendment: amended.result, delivery: delivered.result });
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
        // The one piece of bookkeeping a dismissal still owes: an agent asking to be
        // changed learns from the refusal record, not from the bead. Closed with no
        // record, its request is not refused — it is unheard, and it files the same
        // one again next week. `isApproval` matches a leading marker only, and this
        // response begins with "Dismissed", so this can never amend anything.
        //
        // Tolerated rather than awaited on: a foundation that cannot be written, or a
        // request block that no longer parses, must not be what stops you binning the
        // card. That is the exact card you most want gone.
        try {
          const refused = await resolveAmendmentFor(ws, body.id, `Dismissed via Beadcause${note ? ` — ${note}` : ''}`);
          if (refused.note) console.log(`[beadcause] dismissal recorded against ${ws.name}/${body.id}`);
        } catch (err) {
          console.error(`[beadcause] could not record the dismissal of ${ws.name}/${body.id}: ${err.message.split('\n')[0]}`);
        }
        await bd.dismiss(ws, body.id, note);
        console.log(`[beadcause] dismissed ${ws.name}/${body.id}${note ? ` — ${note.split('\n')[0]}` : ''}`);
        // Same event as an answer, because it means the same thing to every other
        // client: that card is gone. A tablet holding a notification for it must
        // drop the notification whether the question was answered or binned.
        bus.emit({ type: 'answered', key: `${ws.name}/${body.id}`, workspace: ws.name, id: body.id });
        return json(res, 200, { ok: true, closed: true, dismissed: true });
      }

      if (p === '/api/comment' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = requireWorkspace(body.workspace);
        if (!body.id || !String(body.text || '').trim()) {
          return json(res, 400, { error: 'id and text are required' });
        }
        await bd.comment(ws, body.id, String(body.text));
        // Commenting without answering means the ball is in an agent's court.
        // The label is the signal a session can actually find: `bd list --label=human-replied`.
        try {
          await bd.addLabel(ws, body.id, REPLIED_LABEL);
        } catch (err) {
          console.error(`[beadcause] could not flag ${ws.name}/${body.id}: ${err.message.split('\n')[0]}`);
        }
        // Baseline the thread on our own write. Attribution is now deterministic
        // (--actor), but this makes a self-notify impossible even if it weren't.
        try {
          const n = (await bd.comments(ws, body.id)).length;
          hooks.rebaseline?.(`${ws.name}/${body.id}`, n);
        } catch {
          /* the poller baselines it on the next tick */
        }
        console.log(`[beadcause] commented on ${ws.name}/${body.id} — awaiting agent`);
        bus.emit({ type: 'commented', key: `${ws.name}/${body.id}`, workspace: ws.name, id: body.id });

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
        const pick = (v) => (typeof v === 'string' && v ? v : 'all');
        const filter = { space: pick(body.space), workspace: pick(body.workspace) };
        saveState({ filter });
        return json(res, 200, { ok: true, filter });
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

        const { dir, mode } = await openSession(cfg, ws, id, q.question || q.title);
        console.log(`[beadcause] opened a session on ${ws.name}/${id} in ${dir} (permission mode: ${mode})`);
        return json(res, 200, { ok: true, dir, mode });
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
        return json(res, 200, { consoles: listConsoles(), workspaces: [...workspaces.keys()] });
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

      if (p === '/api/foundation' && req.method === 'GET') {
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
        return json(res, 200, { ok: true, consoles: listConsoles() });
      }

      /**
       * Every workspace at once: who is working on what, the counts, and enough to
       * get from here into that workspace's graph.
       *
       * Two `bd` calls per workspace, run in parallel across all of them — about a
       * second in total for six. Deliberately not folded into /api/questions: that
       * one is polled every 30 seconds by every client, and this is opened when you
       * want it.
       */
      if (p === '/api/work' && req.method === 'GET') {
        // Read off the filesystem before the bd sweep, so every workspace row is
        // matched against the same snapshot of what was running.
        const sessions = liveSessions(cfg);
        const rows = await collectWork(bd, cfg.workspaces, readActivity(), sessions);
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

      /** Every advocate's state on its own, for anything that isn't the work page. */
      if (p === '/api/advocates' && req.method === 'GET') {
        return json(res, 200, { advocates: advocates.snapshot() });
      }

      /**
       * Pause, resume, or hand back the slots of one advocate.
       *
       * `release` is the button for "I closed those windows myself": the sessions
       * are iTerm's, not ours, so nothing here can see them go. It frees the slots
       * and touches no bead.
       */
      if (p === '/api/advocate' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.workspace || '');
        if (!advocates.has(name)) return json(res, 404, { error: `no advocate for ${name || '(none given)'}` });
        advocates.control(name, String(body.action || ''));
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
       * One live session's own Claude Code transcript, tailed.
       *
       * Addressed by **pid**, never by path: the pid is matched against the sessions
       * the page itself just reported, and the file is resolved from the record
       * Claude Code wrote. So a request cannot name a file, and a transcript can only
       * be read for a process that is running right now.
       *
       * A pid that has gone is a 404 saying so rather than an empty pane — you tapped
       * a row for a session that exited between the refresh and the tap, and "it
       * finished" is a different fact from "it has done nothing".
       */
      if (p === '/api/session-log' && req.method === 'GET') {
        const pid = Number(url.searchParams.get('pid'));
        // Re-read rather than cache: `/clear` rewrites the record with a new session
        // id, and the pane must follow the conversation the process is actually on.
        const session = liveSessions(cfg).find((s) => s.pid === pid);
        if (!session) return json(res, 404, { error: `no session running as pid ${pid || '(none given)'}` });
        const { file, lines } = tailTranscript(cfg, session);
        return json(res, 200, {
          pid: session.pid,
          sessionId: session.sessionId,
          status: session.status,
          // Where it looked, so an empty pane can say why it is empty.
          file,
          lines,
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

  return { handler, allQuestions, foundationRequests, splitChannels, bd, hooks, bus, advocates };
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
  async function checkReplies(questions) {
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
      const replyQuiet = isQuiet(spaceFor(cfg, q.workspace));
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
      });
      if (!replyQuiet) {
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
      const quiet = isQuiet(spaceFor(cfg, q.workspace));
      app.bus.emit({
        // The distinct event type. Everything downstream — the phone's pane, the
        // terminal monitor's pane, the Android shell's notification channel —
        // branches on this rather than on a label it would have to re-read.
        type: q.foundation ? 'foundation-request' : 'question',
        key: q.key, workspace: q.workspace, id: q.id,
        title: q.question || q.title, space: q.space || null, quiet,
        // Only a foundation request has one, and it is what the pane draws its
        // headline from: which agent, and how narrow the ask is.
        ...(q.foundation ? { agent: q.amendment?.agent || null, scope: q.amendment?.scope || null } : {}),
      });
      if (quiet) {
        console.log(`[beadcause] ${q.key} arrived quietly (${q.space} is muted right now)`);
        continue;
      }
      try {
        // Same as above: say what actually happened. The event has already been
        // emitted, so a skipped push is not a lost question — only a quiet one.
        const sent = q.foundation ? await pushFoundationRequest(cfg, q) : await pushQuestion(cfg, q);
        const what = q.foundation ? `foundation request ${q.key}` : q.key;
        if (sent?.skipped) console.log(`[beadcause] ${what} arrived (ntfy off — clients poll for it)`);
        else console.log(`[beadcause] pushed ${what}`);
      } catch (err) {
        console.error(`[beadcause] push failed for ${q.key}: ${err.message}`);
      }
    }

    await checkReplies(questions.filter((q) => !fresh.includes(q)));

    // Answered somewhere other than here (an agent closed it, or `bd close` on the
    // Mac). Clients holding a notification for it need to drop it.
    for (const key of notified) if (!live.has(key)) app.bus.emit({ type: 'answered', key });

    // Drop answered questions so a reopened bead notifies again.
    notified = new Set(live);
    counts = Object.fromEntries(Object.entries(counts).filter(([k]) => live.has(k)));
    pruneActivity(live);
    saveState({ notified: [...notified], commentCounts: counts });
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
  const cycle = async () => {
    await tick();
    try {
      await app.advocates?.tick();
    } catch (err) {
      console.error('[advocate] tick failed:', err.message);
    }
  };

  cycle();
  return setInterval(cycle, Math.max(5, cfg.pollSeconds || 30) * 1000);
}

export function listen(cfg, handler) {
  const hosts = ['127.0.0.1'];
  if (cfg.host && cfg.host !== '127.0.0.1') hosts.push(cfg.host);

  let bound = 0;
  let failed = 0;
  const servers = hosts.map((host) => {
    const server = http.createServer(handler);
    server.on('error', (err) => {
      console.error(`[beadcause] listen ${host}:${cfg.port} — ${err.message}`);
      // Bind failure on every address means another instance owns the port. Die,
      // rather than lingering as a listener-less process whose poller still fires
      // pushes — launchd's KeepAlive can't see that, and two pollers double-notify.
      if (++failed === hosts.length && bound === 0) {
        console.error('[beadcause] no address could be bound — exiting');
        process.exit(1);
      }
    });
    server.listen(cfg.port, host, () => {
      bound++;
      console.log(`[beadcause] listening on http://${host}:${cfg.port}`);
    });
    return server;
  });
  return servers;
}
