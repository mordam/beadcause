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
import { CONFIG_DIR, OBSERVING, OBSERVING_NOTE } from './config.js';
import { writeJsonAtomic } from './atomic.js';
import { snapshot } from './commonrepo.js';
import { checkinMessage, messageSession, openWorkSession, resolveSessionDir } from './session.js';
import { liveSessions } from './claude.js';
import { isWorkspaceQuiet, spaceFor, quietUntil } from './spaces.js';
import { setActivity, clearActivity } from './activity.js';
import * as agentlog from './agentlog.js';
import { parseProposal, proposalBody, proposalTitle } from './proposal.js';
import { sweepWorktrees, describeSweep } from './tidy.js';
import { archiveSession, mergeCommitFor, noteMerge, mainCheckout } from './sessionlog.js';
import { effective, claudeArgs, agentEnv } from './foundation.js';
import { memoryBrief } from './memory.js';
import { lookupBrief } from './lookup.js';
import { ownerName } from './owner.js';
import * as amendment from './amendment.js';
import { parseDelivery, DELIVERY_LABEL } from './delivery.js';

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

/** Hard ceiling on the configurable ceiling. Three windows is already a lot of Mac. */
const MAX_WORKERS_CEILING = 9;

const DEFAULTS = {
  enabled: true,
  workspaces: [],
  maxWorkers: 1,
  maxWorkersLimit: 3,
  globalMaxWorkers: 3,
  perWorkspace: {},
  minPriority: 3,
  settleSeconds: 60,
  launchCooldownSeconds: 120,
  lapseMinutes: 10,
  workerTimeoutMinutes: 120,
  checkinMinutes: 10,
  maxAttemptsPerBead: 2,
  respectQuietHours: true,
  propose: true,
  proposeCooldownHours: 12,
  maxProposals: 5,
  proposeTimeoutMs: 600000,
  tidyWorktrees: true,
  tidyIntervalMinutes: 15,
  sessionLog: true,
  sessionTranscripts: false,
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
 * How many sessions this advocate may have open at once.
 *
 * Two numbers, because they answer different questions: `maxWorkers` is what you
 * want, `maxWorkersLimit` is how far you are willing to let any one repo go. The
 * request is clamped to the ceiling rather than refused — a config asking for six
 * should give you the most it will allow, and say so once, not fail to start.
 */
export function workerLimit(cfg, name) {
  const o = options(cfg);
  const ceiling = clampInt(o.maxWorkersLimit, 1, MAX_WORKERS_CEILING, DEFAULTS.maxWorkersLimit);
  const want = o.perWorkspace?.[name]?.maxWorkers ?? o.maxWorkers;
  return { limit: clampInt(want, 1, ceiling, 1), ceiling, requested: Math.floor(Number(want)) || 1 };
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
 * `say` is the channel to one open session, injectable only so the tests can watch it:
 * the real one drives iTerm through an Apple event, which no test suite should need.
 * Everything else here takes the default.
 */
export function createAdvocates(cfg, { bd, bus, say = messageSession }) {
  const o = options(cfg);
  const saved = loadState();
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
      attempts: prev.attempts || {},
      lastProposalAt: prev.lastProposalAt || null,
      lastLaunchAt: prev.lastLaunchAt || null,
      lastTidyAt: prev.lastTidyAt || null,
      lastSurveyAt: null,
      tidy: null,
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
        attempts: a.attempts,
        lastProposalAt: a.lastProposalAt,
        lastLaunchAt: a.lastLaunchAt,
        lastTidyAt: a.lastTidyAt,
        lastArchive: a.lastArchive,
        pendingNotes: a.pendingNotes,
      };
    }
    saveState(out);
  }

  const totalWorkers = () => [...advocates.values()].reduce((n, a) => n + a.workers.length, 0);

  /** Say it once. An advocate ticks every 30s and would otherwise fill the log. */
  function note(a, text, level = 'log') {
    if (a.note === text) return;
    a.note = text;
    if (text) console[level === 'warn' ? 'warn' : 'log'](`[advocate] ${a.name}: ${text}`);
  }

  function emit(a, action, extra = {}) {
    bus?.emit({ type: 'advocate', key: extra.id ? `${a.name}/${extra.id}` : a.name, workspace: a.name, action, ...extra });
  }

  /* ------------------------------------------------------------ the survey */

  /**
   * What counts as work.
   *
   * `bd ready` already excludes in_progress, blocked, deferred and hooked, which is
   * most of the definition — an advocate that pushed at blocked beads would be
   * pushing at something only another bead can move. On top of that: questions are
   * yours, not its; and P4 is a backlog, which is a list of things deliberately not
   * being done. Both are configurable, and the numbers say which is which on the
   * card rather than silently shrinking the queue.
   */
  async function survey(a) {
    const rows = await bd.ready(a.workspace, { excludeLabel: 'human' });
    const max = clampInt(o.minPriority, 0, 4, DEFAULTS.minPriority);
    const kept = rows.filter((r) => (r.priority ?? 2) <= max);
    a.deferredByPriority = rows.length - kept.length;
    return kept
      .map((r) => ({
        id: r.id,
        title: r.title || r.id,
        priority: r.priority ?? 2,
        type: r.issue_type || 'task',
        createdAt: r.created_at || null,
        updatedAt: r.updated_at || r.created_at || null,
      }))
      // Sorted here, not only where the launch is chosen, because the card shows
      // the head of this list as "next": bd's own order is close but not the same,
      // and a "next" that isn't what gets picked is a lie with no upside.
      .sort(byPickOrder);
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

      const mine = sessions.find((s) => s.name && s.name.includes(w.id));
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
        const landed = (String(issue.close_reason || '').match(/\bLanded as (#\d+)/) || [])[1];
        finish(
          a,
          w,
          landed
            ? `landed ${landed} — the session merged its own pull request${ended ? ' and exited' : ''}`
            : ended
              ? 'closed by the session, which then exited'
              : 'closed by the session',
          'done'
        );
        continue;
      }
      if (ended) {
        // It exited without closing the bead. Handing it back is a documented and
        // perfectly good ending — the brief asks for it — so it costs no attempt;
        // anything else does, or the same window reopens forever.
        const handedBack = (issue.labels || []).includes('human');
        // And so is delivering. A worker that landed its own work closed its bead on
        // the way out and was caught above; this is the other delivery — the merge was
        // refused, or the session asked for review, so the bead is *supposed* to still
        // be open with a question in front of it. Without this that ending would read
        // as "exited unfinished", cost an attempt, and after two of them the advocate
        // would give up on a bead whose work was sitting in a pull request waiting on
        // a tap.
        const delivered = handedBack ? null : await deliveryFor(a, w.id);
        if (delivered) {
          delete a.attempts[w.id];
          finish(a, w, `delivered as a pull request — waiting on ${delivered} for the merge`, 'delivered');
        } else if (handedBack) {
          delete a.attempts[w.id];
          finish(a, w, 'handed back to you — it needs a decision', 'handback');
        } else {
          a.attempts[w.id] = (a.attempts[w.id] || 0) + 1;
          finish(
            a,
            w,
            `the session exited without closing it${ended.code ? ` (exit ${ended.code})` : ''}`,
            'unfinished'
          );
        }
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
   * One `bd` call, only ever when a session has just ended.
   */
  async function deliveryFor(a, beadId) {
    let open;
    try {
      open = await bd.listLabel(a.workspace, DELIVERY_LABEL);
    } catch {
      return null; // A tracker that will not answer is not evidence of anything.
    }
    for (const q of open || []) {
      if (q.status === 'closed') continue;
      const d = parseDelivery([q.description, q.design, q.notes].filter(Boolean).join('\n\n'));
      if (d && !d.error && d.bead === beadId) return q.id;
    }
    return null;
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
    const { dir, mode, term } = await openWorkSession(cfg, a.workspace, bead, {
      attempt,
      doneFile: doneFileFor(a.name, bead.id),
    });

    a.workers.push({
      id: bead.id,
      title: bead.title,
      priority: bead.priority,
      at: iso(),
      dir,
      attempt,
      claimed: false,
      pid: null,
      sessionStatus: null,
      // The iTerm session id, kept for the life of the worker: it is what `reclaim`
      // addresses to ask this window whether it is still working. Null on an iTerm
      // that would not report one, which reclaim treats as "cannot ask".
      term: term || null,
      asked: null,
      checkedInAt: null,
      checkinNote: '',
    });
    a.lastLaunchAt = iso();

    // Reuse the phase chip every other agent in beadcause writes to: the bead now
    // shows as being worked on in the inbox, the graph and the monitor without any
    // of them knowing an advocate exists.
    setActivity(key, { phase: 'building', detail: `session opened by the ${a.name} advocate`, actor: 'advocate' });
    console.log(`[advocate] ${a.name}: opened a session on ${bead.id} in ${dir} (${mode}, attempt ${attempt})`);
    emit(a, 'launched', { id: bead.id, title: bead.title, detail: `session in ${path.basename(dir)}` });
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
      const beads = await surveyAgent(a);
      if (!beads.length) {
        a.lastProposalAt = iso();
        note(a, 'nothing worth proposing — idle');
        emit(a, 'idle', { detail: 'the survey found nothing worth filing' });
        return;
      }
      const id = await bd.create(a.workspace, {
        title: proposalTitle(a.name, beads),
        body: proposalBody(a.name, beads),
        priority: 2,
        type: 'task',
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
   * The read-only agent that writes the proposal.
   *
   * Streamed to a log the way lib/dispatch.js streams its replies, so "the advocate
   * is thinking" is something you can actually watch rather than a chip that sits
   * there for four minutes. Its answer has to come back as a fenced block: asking
   * for prose and parsing it later is how you end up filing a bead titled "Sure,
   * here are three ideas:".
   */
  async function surveyAgent(a) {
    const dir = resolveSessionDir(cfg, a.workspace);
    const key = `${a.name}/advocate`;
    agentlog.reset(key);
    agentlog.append(key, `● surveying ${a.name} in ${dir}`);

    // The advocate's foundation comes from the repo it advocates for, not from
    // beadcause's own checkout: an amendment is per agent kind, but it is stored
    // wherever that agent runs, so a repo can carry a differently-scoped advocate.
    const f = await effective(dir, 'advocate');

    // The survey is the one moment an advocate has just spent ten minutes finding
    // out what it could not see, which makes it the right place to ask whether the
    // means were missing rather than the work.
    let reflection = '';
    try {
      reflection = amendment.reflectionPrompt(f, await amendment.refusalsFor(dir, 'advocate'), ownerName(cfg));
    } catch (err) {
      console.error(`[advocate] ${a.name}: no reflection step — ${err.message.split('\n')[0]}`);
    }

    const promptFile = path.join(os.tmpdir(), `beadcause-advocate-${crypto.randomBytes(6).toString('hex')}.md`);
    fs.writeFileSync(promptFile, surveyPrompt(a.name, o, reflection, ownerName(cfg)), { mode: 0o600 });
    const command =
      `P="$(cat '${promptFile}')"; rm -f '${promptFile}'; ` +
      `exec claude -p "$P" ${claudeArgs(f).join(' ')} --output-format stream-json --verbose`;

    return new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd: dir,
        // See `agentEnv`: `beadcause-memory` on PATH, and who this agent is stamped
        // where it cannot claim to be somebody else.
        env: agentEnv(f),
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
        // Separately from the proposal, and after it: what the advocate wants for
        // itself must never interfere with what it found for you. A survey that
        // proposed nothing can still have hit a wall worth hearing about.
        void fileAmendment(a, dir, key, answer, denials);

        const parsed = parseProposal(answer);
        if (!parsed) {
          agentlog.append(key, '● nothing proposed');
          return resolve([]);
        }
        if (parsed.error) {
          agentlog.append(key, `● ${parsed.error}`);
          return reject(new Error(parsed.error));
        }
        const capped = parsed.beads.slice(0, clampInt(o.maxProposals, 1, 20, DEFAULTS.maxProposals));
        if (capped.length < parsed.beads.length) {
          // Never a silent truncation: the difference between "it found three" and
          // "it found eleven and you are seeing three" is the whole of the picture.
          agentlog.append(key, `● proposing ${capped.length} of ${parsed.beads.length} (maxProposals)`);
          console.log(`[advocate] ${a.name}: survey returned ${parsed.beads.length}, proposing ${capped.length} (maxProposals)`);
        }
        agentlog.append(key, `● proposing ${capped.length} bead(s)`);
        resolve(capped);
      });
    });
  }

  /**
   * File the advocate's own request to be different, if it made one.
   *
   * Same three filters as lib/dispatch.js applies, for the same reason: a request
   * with no scope, a request re-arguing something already refused, and a second
   * request while one is open are all noise in the one channel Adam reads for
   * constitutional questions, and noise there is what makes him stop opening it.
   *
   * Never allowed to break the survey. The proposal is the advocate's job and this
   * is a by-product of having done it.
   */
  async function fileAmendment(a, dir, key, text, denials) {
    const request = amendment.parseAmendment(text);
    if (!request) return;
    if (request.error) {
      console.error(`[advocate] ${a.name}: ignoring a malformed amendment request — ${request.error}`);
      agentlog.append(key, `● amendment request rejected: ${request.error}`);
      return;
    }
    if (denials.length) {
      request.evidence = [request.evidence, ...denials.map((d) => `- ${d}`)].filter(Boolean).join('\n');
    }
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

    let dir;
    try {
      dir = resolveSessionDir(cfg, a.workspace);
    } catch {
      return;
    }
    const withTranscript = Boolean(o.perWorkspace?.[a.name]?.sessionTranscripts ?? o.sessionTranscripts);

    for (const { worker, outcome } of finished) {
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
          a.pendingNotes.push({ bead: worker.id, ref: res.ref, head: res.head, branch: res.branch });
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
    let main;
    try {
      main = await mainCheckout(dir);
    } catch {
      return;
    }
    const still = [];
    const usePr = cfg.pr?.enabled !== false && cfg.pr?.tidyMerged !== false;
    for (const p of a.pendingNotes) {
      try {
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
   */
  async function tidy(a, sessions) {
    if (!o.tidyWorktrees || OBSERVING) return;
    const due = a.sweepDue || minsSince(a.lastTidyAt) >= clampInt(o.tidyIntervalMinutes, 1, 24 * 60, DEFAULTS.tidyIntervalMinutes);
    if (!due) return;

    let dir;
    try {
      dir = resolveSessionDir(cfg, a.workspace);
    } catch {
      return; // No checkout for this workspace: nothing here has worktrees to sweep.
    }

    a.sweepDue = false;
    a.lastTidyAt = iso();
    await notePending(a, dir);
    try {
      // `prMerges` is what makes the sweep keep working now that nothing merges
      // locally: a squash-merged branch is never an ancestor of main, so without it
      // every delivered worktree would sit there forever being described as unmerged.
      const result = await sweepWorktrees(dir, { sessions, prMerges: cfg.pr?.enabled !== false && cfg.pr?.tidyMerged !== false });
      const summary = describeSweep(result);
      a.tidy = { summary, retired: result.retired.length, at: a.lastTidyAt };
      // Only when something moved. A sweep that found nothing to do is the normal
      // case and would otherwise print every fifteen minutes for every repo.
      if (result.retired.length) {
        console.log(`[advocate] ${a.name}: ${summary}`);
        emit(a, 'tidied', { detail: summary });
      }
    } catch (err) {
      a.tidy = { summary: `sweep failed: ${err.message.split('\n')[0]}`, retired: 0, at: a.lastTidyAt };
      console.error(`[advocate] ${a.name}: worktree sweep failed — ${err.message.split('\n')[0]}`);
    }
  }

  /* --------------------------------------------------------------- the tick */

  async function tickOne(a, sessions) {
    a.error = null;
    a.quiet = o.respectQuietHours && isWorkspaceQuiet(cfg, a.name);

    await reconcile(a, sessions.filter((s) => s.workspace === a.name));
    // Before the sweep: the archive needs the worktree where the session left it.
    await archiveFinished(a);
    // Every live session, not just this repo's: a worktree is protected by whoever
    // is sitting in it, and `workspace` is null for a session outside any of them.
    await tidy(a, sessions);

    try {
      a.queue = await survey(a);
      a.lastSurveyAt = iso();
    } catch (err) {
      a.error = err.message.split('\n')[0];
      note(a, `cannot read the tracker — ${a.error}`, 'warn');
      return;
    }

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

    const free = a.limit - a.workers.length;
    const globalFree = clampInt(o.globalMaxWorkers, 1, MAX_WORKERS_CEILING * 4, DEFAULTS.globalMaxWorkers) - totalWorkers();
    const ready = candidates(a);

    if (!a.queue.length) {
      note(a, a.workers.length ? `${a.workers.length} session(s) working, nothing else ready` : 'clear — no ready beads');
      if (!a.workers.length && o.propose) await propose(a);
      return;
    }
    if (free <= 0) return note(a, `${a.queue.length} ready · at its limit of ${a.limit} session(s)`);
    if (globalFree <= 0) return note(a, `${a.queue.length} ready · held by globalMaxWorkers (${o.globalMaxWorkers})`);
    if (!ready.length) {
      const settling = a.queue.length - ready.length;
      return note(a, `${a.queue.length} ready · ${settling} settling or already tried`);
    }
    if (secsSince(a.lastLaunchAt) < clampInt(o.launchCooldownSeconds, 0, 3600, DEFAULTS.launchCooldownSeconds)) {
      return note(a, `${ready.length} to pick up · cooling down since the last launch`);
    }

    const slots = Math.min(free, globalFree, ready.length);
    note(a, `${a.queue.length} ready · opening ${slots} session(s)`);
    for (const bead of ready.slice(0, slots)) {
      try {
        await launch(a, bead);
      } catch (err) {
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
      queue: a.queue.length,
      // Only the top few travel: the card shows what it is about to pick up, and
      // the whole list is a `bd ready` away in the graph.
      next: a.queue.slice(0, 3),
      workers: a.workers.map((w) => ({
        id: w.id,
        title: w.title,
        at: w.at,
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
      note: a.note,
      error: a.error,
      surveying: a.surveying,
      lastSurveyAt: a.lastSurveyAt,
      lastLaunchAt: a.lastLaunchAt,
      lastProposalAt: a.lastProposalAt,
      tidy: a.tidy,
      archive: a.lastArchive,
      pendingNotes: a.pendingNotes.length,
      deferredByPriority: a.deferredByPriority || 0,
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

  async function control(name, action) {
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
    } else {
      throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 });
    }
    persist();
    return a;
  }

  return {
    tick,
    snapshot,
    control,
    has: (name) => advocates.has(name),
    get size() {
      return advocates.size;
    },
    /** For the log endpoint: where the survey agent's transcript lives. */
    logKey: (name) => `${name}/advocate`,
  };
}

/* ------------------------------------------------------------------ prompts */

function surveyPrompt(workspace, o, reflection = '', owner = ownerName()) {
  return `You are the **${workspace} advocate** in beadcause. Your queue is empty: there is
no ready work left in this repo's beads tracker, and your job is to decide whether
that is genuinely finished or merely untracked.

You are running read-only. You can read the repo, run \`bd\`, read git history, and
look things up on the web (see below).
You cannot edit anything, and **you must not create any beads** — ${owner} approves
every bead before it exists. Your entire output is a proposal for them to accept or
reject.

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
before you propose.

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
    description: |
      Why this bead exists and what needs to be done. Write it for someone
      opening it cold in three weeks: name the files, name the symptom, say
      what the fix looks like. This is what a session will work from.
    acceptance: What has to be true for this to be closed.
    rationale: How you found it — the commit, the comment, the file.
\`\`\`

The description is the part that matters. A one-line bead is a bead someone has to
rediscover from scratch, and ${owner} is approving it on the strength of what you wrote.

${lookupBrief(owner)}

Use it sparingly here. Most of what makes a proposal good is inside the repo, and a
survey that goes reading the web is usually a survey that has run out of real work to
find. It earns its place when the repo's own claims turn on something outside it — an
upstream that has moved, a spec the code half-implements, a dependency whose successor
already shipped.

${memoryBrief(owner)}

You are the agent this matters most to: you survey the same repo again and again, and
"I proposed this and it was declined" is not something the tracker will tell you —
a declined proposal leaves no bead behind. \`recall\` before you propose, and
\`remember\` what ${owner} turned down and why. \`post\` on a topic when it is the *other*
advocates who need to know.

${reflection}`;
}
