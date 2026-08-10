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
import { checkinMessage, messageSession, openWorkSession, resolveSessionDir } from './session.js';
import { liveSessions } from './claude.js';
import { isWorkspaceQuiet, spaceFor, quietUntil } from './spaces.js';
import { setActivity, clearActivity } from './activity.js';
import * as agentlog from './agentlog.js';
import { parseProposal, proposalBody, proposalTitle, dupeNote } from './proposal.js';
import { annotateDuplicates, liveCandidates } from './dupe.js';
import { sweepWorktrees, describeSweep } from './tidy.js';
import { archiveSession, mergeCommitFor, noteMerge, mainCheckout } from './sessionlog.js';
import { effective, claudeArgs, agentEnv } from './foundation.js';
import { memoryBrief } from './memory.js';
import { lookupBrief } from './lookup.js';
import { ownerName } from './owner.js';
import * as amendment from './amendment.js';
import { parseDelivery, DELIVERY_LABEL } from './delivery.js';
import { closingFor, decide, namesBead, signal, REAP_DEFAULTS } from './reap.js';

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

const DEFAULTS = {
  enabled: true,
  workspaces: [],
  maxWorkers: 1,
  maxWorkersLimit: 3,
  globalMaxWorkers: 10,
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
      // Windows whose bead is closed and whose process is still there, waiting out
      // the grace period before they are signalled. Carried across a restart for the
      // same reason `workers` is — the windows are still open, and a daemon that
      // forgot them would leave the pile it was written to clear.
      closing: Array.isArray(prev.closing) ? prev.closing : [],
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
        closing: a.closing,
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
    clampInt(o.globalMaxWorkers, 1, MAX_WORKERS_CEILING * 4, DEFAULTS.globalMaxWorkers);

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
   * yours, not its; a bead still waiting for your endorsement is nobody's yet, and
   * nothing may open a session on one at all (see lib/endorse.js); and P4 is a
   * backlog, which is a list of things deliberately not being done. The priority
   * floor is configurable, and the numbers say which is which on the card rather
   * than silently shrinking the queue.
   *
   * Everything this advocate later reports as "N ready" is `a.queue`, which is this
   * list — so excluding held beads here is also what keeps them out of the count.
   */
  async function survey(a) {
    const rows = await bd.ready(a.workspace, { excludeLabels: QUEUE_EXCLUDED });
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
    // A worker leaves the slot list here, so this is the last moment its pid is
    // known. If it ended by closing its bead and is still running, the window is one
    // of the ones that never closes — hand it to the reaper. See lib/reap.js.
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
    // `bd` is what lets the launcher refuse an unendorsed bead — it asks the tracker
    // rather than trusting the queue row, so the refusal holds even if the survey's
    // filter somehow handed it one. See lib/endorse.js.
    const { dir, mode, term } = await openWorkSession(cfg, a.workspace, bead, {
      attempt,
      bd,
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

    const mine = sessions.filter((s) => s.workspace === a.name);
    await reconcile(a, mine);
    // After the reconcile, which is what puts things on the closing list, and before
    // the sweep, which is happier once the window it wants to retire has gone.
    reapClosing(a, mine);
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
    const globalFree = globalLimit() - totalWorkers();
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
      // Windows whose bead is closed and whose process is still up, waiting to be
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
