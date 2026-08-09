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
 * the console agent's allowlist" but "why did that happen, and what stopped it".
 *
 * Four sources, deliberately not merged into one shape:
 *
 * - the **foundation** and its amendment history, from refs/beadcause/foundations
 * - **live activity**, from `~/.config/beadcause/status.json` (lib/activity.js)
 * - **recent runs**, which differ per agent kind and are honest about it: an
 *   advocate keeps its own state file, a console is a stored conversation, a worker
 *   is a row in the advocate's `workers` array, and a dispatch leaves only its log
 * - the **streamed log**, from lib/agentlog.js
 *
 * Nothing here invents history that was not recorded. Where an agent kind keeps no
 * run log, this returns an empty list and says why in `runsNote`, so the screen can
 * say "nothing is kept for this one yet" rather than implying it has never run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { AGENTS, effective, history, all as allFoundations, PROTECTED, AMENDABLE } from './foundation.js';
import { readAll as readActivity } from './activity.js';
import * as agentlog from './agentlog.js';
import { listConsoles } from './console.js';

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
  console: () => false, // a console's state is the conversation itself, below
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
 * One agent, everything the screen needs.
 *
 * `dir` decides which repo's amendments apply. That matters for the advocate, which
 * resolves its foundation from the repo it runs in, and is harmless for the rest.
 */
export async function agentDetail(dir, agent, { limit = 20 } = {}) {
  const f = await effective(dir, agent);
  const { runs, runsNote } = runsFor(agent, limit);
  return {
    ...f,
    protectedFields: PROTECTED,
    amendableFields: AMENDABLE,
    activity: activityFor(agent),
    runs,
    runsNote: runsNote || null,
    amendmentHistory: await history(dir, { limit: 50 }),
  };
}

/** Every agent, slim enough to list — no history, no logs. */
export async function agentList(dir) {
  const foundations = await allFoundations(dir);
  return foundations.map((f) => {
    const { runs } = runsFor(f.id, 5);
    const live = activityFor(f.id);
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
  return null; // a console's transcript is the conversation, not a log file
}

export { AGENTS };
