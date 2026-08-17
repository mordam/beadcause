/**
 * The agents screen, server side: what each agent is, what it has been allowed to
 * become, and what it is doing right now.
 *
 * **Named `agentview`, not `agents`, and the reason is worth keeping.** `lib/agents.js`
 * was taken while this was being written, by a roster of *reply personas* — the named
 * briefs you choose between when an agent answers a comment. Two different things
 * arrived at the same word within a day of each other, which is itself the finding:
 * a persona is what one dispatch was *asked* this time, a foundation is what the
 * dispatch agent *is* every time. See the note in lib/foundation.js about that line;
 * this module is the screen over the second one.
 *
 * lib/foundation.js made an agent's definition one object. This assembles the rest
 * of the picture around it, because a foundation on its own does not answer the
 * question you actually have in front of the screen — which is usually not "what is
 * the chat session agent's allowlist" but "why did that happen, and what stopped it".
 *
 * Five sources, deliberately not merged into one shape:
 *
 * - the **foundation** and its amendment history, from refs/beadcause/foundations
 * - **live activity**, from `~/.config/beadcause/status.json` (lib/activity.js)
 * - **recent runs**, which differ per agent kind and are honest about it: an
 *   advocate keeps its own state file, a chat session is a stored conversation, a worker
 *   is a row in the advocate's `workers` array, and a dispatch leaves only its log
 * - the **streamed log**, from lib/agentlog.js
 * - **what it has learned and whether anyone reads it** — the three memory tiers, from
 *   the refs themselves (lib/memory.js) and from the read log beside them
 *   (lib/memoryuse.js). See `memoryFor`: it is the only one of the five that is a
 *   *result* rather than a status, and it is the one the persistence epic is judged by.
 *
 * Nothing here invents history that was not recorded. Where an agent kind keeps no
 * run log, this returns an empty list and says why in `runsNote`, so the screen can
 * say "nothing is kept for this one yet" rather than implying it has never run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import {
  AGENTS,
  effective,
  history,
  all as allFoundations,
  PROTECTED,
  AMENDABLE,
  CARD_FIELDS,
  cardOf,
} from './foundation.js';
import { readAll as readActivity } from './activity.js';
import * as agentlog from './agentlog.js';
import { listConsoles } from './console.js';
import { census } from './memory.js';
import { readsFor } from './memoryuse.js';
import { summary as repoSummary, ARMS } from './agentrepo.js';
import { MERGE_ADVOCATE } from './mergeadvocate.js';

const ADVOCATE_STATE = path.join(CONFIG_DIR, 'advocates.json');

function advocateState() {
  try {
    return JSON.parse(fs.readFileSync(ADVOCATE_STATE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Which activity entries belong to which agent kind.
 *
 * `status.json` is keyed by `workspace/bead`, because it was built to drive the
 * question cards and a bead is what a card is about. The agent that wrote an entry
 * is only recoverable from `actor`, so that is what this matches on — and an entry
 * with no actor is attributed to nothing rather than guessed at, since a wrong
 * attribution here reads as an agent doing work it never did.
 */
const ACTORS = {
  dispatch: (a) => a === 'auto-dispatch',
  advocate: (a) => a === 'advocate',
  worker: (a) => a === 'worker' || a === 'work-session',
  console: () => false, // a chat session's state is the conversation itself, below
  // bc-r941. Its own actor string rather than `advocate`'s: the queue writes activity
  // against the merge-bead while the repo advocate is writing against beads of its own,
  // and a screen that pooled them would attribute a merge to the agent that proposed the
  // work. lib/mergeadvocate.js is what stamps it.
  'merge-advocate': (a) => a === 'merge-advocate',
};

function activityFor(agent) {
  const all = readActivity();
  const match = ACTORS[agent] || (() => false);
  return Object.entries(all)
    .filter(([, v]) => match(v.actor))
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Recent runs, per agent kind, from whatever that kind actually records. */
function runsFor(agent, limit) {
  const st = advocateState();

  if (agent === 'advocate') {
    const runs = Object.entries(st).map(([workspace, a]) => ({
      key: workspace,
      workspace,
      paused: !!a.paused,
      at: a.lastProposalAt || a.lastLaunchAt || null,
      lastProposalAt: a.lastProposalAt || null,
      lastLaunchAt: a.lastLaunchAt || null,
      lastArchive: a.lastArchive || null,
      pendingNotes: (a.pendingNotes || []).length,
      error: a.error || null,
    }));
    return { runs: runs.sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, limit) };
  }

  if (agent === 'worker') {
    const runs = [];
    for (const [workspace, a] of Object.entries(st)) {
      for (const w of a.workers || []) {
        runs.push({
          key: `${workspace}/${w.id}`,
          workspace,
          bead: w.id,
          title: w.title || '',
          at: w.at || null,
          attempt: w.attempt || 1,
          status: w.ended ? 'ended' : w.sessionStatus || (w.claimed ? 'claimed' : 'open'),
          sessionId: w.sessionId || null,
          pid: w.pid || null,
        });
      }
    }
    return { runs: runs.sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, limit) };
  }

  // bc-r941. Its runs are the merge-beads themselves, which is the same argument
  // `assignedAdvocates` makes in lib/epicadvocate.js: a queue item belongs to the queue
  // for as long as its bead is open, and a window list gets that backwards — one whose
  // window exited is still queued, and one whose bead closed is not. The advocate's own
  // state file carries what the last tick did with each of them.
  if (agent === MERGE_ADVOCATE) {
    const runs = [];
    for (const [workspace, a] of Object.entries(st)) {
      for (const m of a.merges || []) {
        runs.push({
          key: `${workspace}/${m.id}`,
          workspace,
          bead: m.id,
          title: m.title || '',
          at: m.at || null,
          attempt: m.attempts || 0,
          status: m.status || 'queued',
          number: m.number ?? null,
          refused: m.refused || null,
        });
      }
    }
    return {
      runs: runs.sort((x, y) => String(y.at || '').localeCompare(String(x.at || ''))).slice(0, limit),
      runsNote: runs.length
        ? ''
        : 'Nothing is queued. A run here is a merge-bead a worker filed; the queue keeps no history of the ones that landed, because the merge itself is the record.',
    };
  }

  if (agent === 'console') {
    const runs = listConsoles(limit).map((c) => ({
      key: c.id,
      workspace: c.workspace || '',
      title: c.title || c.seed?.title || '',
      at: c.updatedAt || c.createdAt || null,
      status: c.status || 'idle',
      messages: c.messages ?? c.messageCount ?? null,
    }));
    return { runs };
  }

  // dispatch keeps no run history of its own: a reply is a bd comment on the bead,
  // and the only local trace is the rendered log, which the next dispatch resets.
  return {
    runs: [],
    runsNote: 'A dispatch leaves its answer as a comment on the bead. Nothing else is kept — the next one resets the log.',
  };
}

/**
 * What an agent has written, and whether any of it has ever been opened.
 *
 * The epic that built the three tiers had no screen answering the question it exists
 * to answer — *is an agent actually carrying anything between runs* — and reading it
 * meant four git commands and a subtraction. This is those commands, done once, for
 * every agent on one screen.
 *
 * **Written and read come from different places on purpose.** The counts are the refs
 * themselves (lib/memory.js `census`), so they cannot drift from what `git log` says;
 * the reads are lib/memoryuse.js's log, because a ref cannot record having been looked
 * at. That split is also why the write column is trustworthy for the whole history and
 * the read column only from the day the instrument landed — which the screen says out
 * loud rather than leaving to be inferred from a suspicious zero.
 *
 * **`unread` is the number the prediction turns on.** A key that was written and never
 * opened *by name* is a diary entry; the store being listed wholesale is a glance and
 * is counted separately, because folding the two together would let a single bare
 * `recall` mark 244 notes as read.
 */
async function memoryFor(dir, foundation, agents, { workspace = '' } = {}) {
  const { repo, agents: written } = await census(dir, agents);
  const reads = readsFor(agents, { repo });
  const id = foundation.id;
  const mine = written[id] || { memory: { keys: [], writes: 0, lastWriteAt: null }, notes: { keys: [], writes: 0, lastWriteAt: null } };
  const seen = reads[id] || {};

  const tier = (store, log) => ({
    keys: store.keys.length,
    writes: store.writes,
    lastWriteAt: store.lastWriteAt,
    reads: log?.reads || 0,
    listings: log?.listings || 0,
    // Only keys that are actually *in* the store: a read of a key that has since been
    // renamed says nothing about whether what is there now has ever been wanted.
    opened: (log?.keys || []).filter((k) => store.keys.includes(k)).length,
    unread: store.keys.filter((k) => !(log?.keys || []).includes(k)).length,
    lastReadAt: log?.lastAt || null,
    sessions: log?.beads || 0,
  });

  return {
    repo,
    workspace,
    notes: { ...tier(mine.notes, seen.notes), ref: mine.notes.ref },
    memory: tier(mine.memory, seen.memory),
    bus: { reads: seen.bus?.reads || 0, topics: (seen.bus?.keys || []).length, lastReadAt: seen.bus?.lastAt || null },
    debriefs: { reads: seen.debrief?.reads || 0, lastReadAt: seen.debrief?.lastAt || null },
    readByOthers: seen.byThem || 0,
    // Tier 3, narrowed to this agent — see the note on `summary` about what a pooled
    // number would be answering. `null` for the four agents that own no repo, so the
    // screen can leave the row out rather than draw four zeroes that mean "not applicable".
    //
    // Narrowed by agent and **not** by workspace, which is the one place the two
    // narrowings differ. An arm is assigned per workspace-and-agent (`armFor`), so a
    // workspace with a single run has only ever been in one arm — and a screen that
    // filtered to the repo you happen to be looking at would show two empty arms on
    // every workspace but the one the run happened in, which is the epic's only
    // evidence made invisible by the surface built to show it.
    own: foundation.ownsRepo ? { arms: ARMS, summary: repoSummary({ agent: id }) } : null,
  };
}

/**
 * One agent, everything the screen needs.
 *
 * `dir` decides which repo's amendments apply. That matters for the advocate, which
 * resolves its foundation from the repo it runs in, and is harmless for the rest.
 */
export async function agentDetail(dir, agent, { limit = 20, workspace = '' } = {}) {
  const f = await effective(dir, agent);
  const { runs, runsNote } = runsFor(agent, limit);
  return {
    ...f,
    protectedFields: PROTECTED,
    amendableFields: AMENDABLE,
    // The card fields are already on `f` — they are foundation fields, so the spread
    // above carries them. This is the *assembled* shape plus the list of which keys
    // are card keys, so a renderer draws whatever the register currently holds rather
    // than five names hard-coded in a browser: a sixth card field added to
    // `CARD_FIELDS` should appear on the screen, not go missing on it.
    card: cardOf(f),
    cardFields: CARD_FIELDS,
    activity: activityFor(agent),
    runs,
    runsNote: runsNote || null,
    // Narrowed to this agent: the ref is every agent's, and this tab is one agent's.
    amendmentHistory: await history(dir, { limit: 50, agent }),
    memory: await memoryFor(dir, f, AGENTS, { workspace }),
  };
}

/**
 * Every agent, slim enough to list — no history, no logs.
 *
 * It does carry how much each one has *learned*, and that is not padding: the finding
 * the persistence epic produced is an asymmetry between agents — one of them with
 * hundreds of notes about this repo and another, running continuously in the same
 * repo, with none — and an asymmetry is a thing you see by putting the rows next to
 * each other. On the detail screen it would be four visits and a subtraction.
 *
 * One `census` for the whole list rather than one per row: the tier-2 store is a single
 * ref holding every agent's file, so asking per agent would re-read the same git log
 * five times.
 */
export async function agentList(dir) {
  const foundations = await allFoundations(dir);
  const ids = foundations.map((f) => f.id);
  let written = {};
  try {
    ({ agents: written } = await census(dir, ids));
  } catch {
    /* a workspace with no repo, or no common repo yet: the list is still the list */
  }
  return foundations.map((f) => {
    const { runs } = runsFor(f.id, 5);
    const live = activityFor(f.id);
    const mem = written[f.id];
    return {
      id: f.id,
      title: f.title,
      purpose: f.purpose,
      writes: f.writes,
      model: f.model,
      amended: f.amended,
      amendments: (f.amendments || []).length,
      declined: (f.amendments || []).filter((a) => a.outcome === 'declined').length,
      busy: live.length,
      lastRunAt: runs[0]?.at || null,
      runs: runs.length,
      notes: mem?.notes.keys.length ?? 0,
      memories: mem?.memory.keys.length ?? 0,
      lastLearnedAt:
        [mem?.notes.lastWriteAt, mem?.memory.lastWriteAt].filter(Boolean).sort().pop() || null,
    };
  });
}

/** The streamed log for one run of one agent, by the key the agent logs under. */
export function agentLog(key, { maxBytes = 64 * 1024 } = {}) {
  return agentlog.tail(key, { maxBytes });
}

/**
 * The log key an agent kind uses for a given run.
 *
 * Centralised because the two conventions were invented in different files —
 * lib/dispatch.js logs under `workspace/bead`, lib/advocate.js under
 * `workspace/advocate` — and a screen that guessed wrong would show an empty pane
 * rather than an error, which is the hardest kind of wrong to notice.
 */
export function logKeyFor(agent, { workspace, bead } = {}) {
  if (agent === 'advocate') return workspace ? `${workspace}/advocate` : null;
  if (agent === 'dispatch' || agent === 'worker') return workspace && bead ? `${workspace}/${bead}` : null;
  return null; // a chat session's transcript is the conversation, not a log file
}

export { AGENTS };
