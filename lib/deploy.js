import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';
import { resolveSessionDir } from './session.js';

/**
 * Deploy a repo — the one act after a merge that this daemon could not do at all.
 *
 * Everything else that finishes a piece of work already has a home. Merging goes
 * through GitHub (lib/pr.js). The board that says whether a merge reached the running
 * build is lib/prboard.js. What was missing between them is the verb: `grep` for
 * `launchctl` across `lib/` and `bin/` found prose in comments and nothing that runs.
 * Every deploy on this Mac has been Adam at a keyboard, and the Ship button on the PR
 * board opens an iTerm window to ask him to be.
 *
 * Four things shape this file, and the awkward one is third.
 *
 * **A deploy is declared, never guessed.** `cfg.deploys[<workspace>]` or nothing —
 * and nothing is the default for every repo. beadcause restarts under launchd, sophab
 * runs `fly deploy`, a third repo rsyncs somewhere; there is no shape those share that
 * could be inferred from a checkout, and a daemon that guessed would eventually guess
 * at three in the morning in a repo nobody was watching. A workspace with no entry is
 * the state lib/prboard.js already has a sentence for: "this repo has no deploy
 * beadcause can see."
 *
 * **The declaration is argv, never a shell string.** `["launchctl", "kickstart", …]`,
 * not `"launchctl kickstart …"`. A string would mean a shell, and a shell would make
 * `~/.config/beadcause/config.json` — a file that is edited by hand, rewritten by
 * `saveConfig`, and synced by lib/commonrepo.js — into somewhere a metacharacter can
 * change what runs. argv has no such reading. The cost is that `&&` and pipes are not
 * available; the answer to wanting them is a script in the repo, which is a thing you
 * can read and test.
 *
 * **The deploy cannot be awaited, because it may kill the caller.** `launchctl
 * kickstart -k gui/<uid>/m4m.beadcause` SIGKILLs the very process that asked for it.
 * An `await` on that never returns, the HTTP response is never written, and — worse —
 * anything the caller had not yet flushed dies with it. So `startDeploy` spawns a
 * **detached** child and returns; the child is what runs the command, and by the time
 * the command lands its parent has already answered. The ordering the caller owes is
 * the other half: make the answer durable *first*, then call this. It is written that
 * way round for exactly this reason, and `graceMs` buys a beat on top so an in-flight
 * response gets out of the socket.
 *
 * **Silence is never success.** Every state a deploy can be in has a name on disk, and
 * the two that mean "we do not know" are named too. A runner killed by its own deploy
 * — which is the *expected* ending for a restart, since launchd may take the whole
 * process tree — leaves `deploying`, and the sweep turns that into `unconfirmed`, not
 * into `ok`. A runner that vanished for any other reason becomes `lost`. Neither ever
 * reads as a deploy that worked.
 *
 * ## Why the journal is a directory, not a key in state.json
 *
 * Two processes are involved and they overlap: the runner writes its own progress
 * while the daemon reads it, and for a restart the daemon in the middle *changes
 * identity*. A single JSON file read-modify-written by both is last-writer-wins over
 * the whole document, so a daemon marking a record announced would silently drop the
 * runner's last step. One file per deploy under `deploys/` gives each runner sole
 * ownership of its own file; the daemon only ever reads them, plus writes a separate
 * empty `<id>.announced` marker beside it. Nothing races.
 *
 * It also sidesteps `loadState`'s fallback entirely, which is the trap a pending-deploy
 * flag in `state.json` would have walked into: an unreadable record here is one deploy
 * whose outcome is unknown — which is exactly what it is — rather than a defaulted
 * field that reads as a deploy nobody asked for or, worse, one silently dropped.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'scripts', 'deploy-runner.mjs');

export const DEPLOY_DIR = path.join(CONFIG_DIR, 'deploys');

/** How many records are kept. A deploy log is for the last few, not for history. */
const KEEP = 40;

/** How long a step may run before the runner gives up on it. */
const DEFAULT_TIMEOUT_MS = 1800000;

/**
 * How long the runner waits before touching anything.
 *
 * Not superstition: the caller is a request handler that has just written a response
 * onto a socket, and the first thing a beadcause deploy does is SIGKILL that process.
 * A second is enough for the write to leave, costs nothing on a deploy that takes
 * minutes, and turns "the phone sometimes sees a dropped connection" into "it doesn't".
 */
const DEFAULT_GRACE_MS = 1000;

/** Statuses a runner still owns. Anything else is settled. */
const LIVE = new Set(['queued', 'pulling', 'building', 'deploying']);

const iso = () => new Date().toISOString();

/* --------------------------------------------------------------- declarations */

/**
 * This user's numeric uid, or undefined where there is no such thing.
 *
 * `os.userInfo()` throws rather than returning null when the uid has no passwd entry —
 * which happens in containers — and a declaration that mentions `{uid}` is not a reason
 * for `deployFor` to throw on a machine where every *other* repo's deploy is fine. An
 * unexpanded `{uid}` fails later, loudly, in the one command that asked for it.
 */
function currentUid() {
  try {
    return os.userInfo().uid;
  } catch {
    return process.getuid?.();
  }
}

/**
 * Substitute the handful of things a declaration cannot know when it is written.
 *
 * A closed set, deliberately. `{uid}` exists because `gui/501/m4m.beadcause` is the
 * one value in a launchd target that differs per machine and would otherwise make the
 * config unshareable; the rest are here because they were already computed. Anything
 * unrecognised is left exactly as it was typed — a brace in an argument is far more
 * likely to be someone's literal brace than a placeholder this file forgot.
 */
function expand(arg, vars) {
  return String(arg).replace(/\{(uid|home|dir|base)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

function argv(value, vars, what) {
  if (!Array.isArray(value) || !value.length) {
    throw Object.assign(new Error(`${what} must be a non-empty array of strings — argv, not a shell line`), { status: 422 });
  }
  if (value.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
    throw Object.assign(new Error(`${what} must contain only strings`), { status: 422 });
  }
  return value.map((a) => expand(a, vars));
}

/**
 * The deploy declared for a workspace, resolved against this machine — or null.
 *
 * Null is a state and not an error: most repos have no deploy, and the ones that do
 * are the exception. A declaration that is *present and wrong* is the opposite, and
 * throws — a typo in `command` must surface when the button is pressed, not by
 * running something unintended or by shrugging and reporting nothing to deploy.
 */
export function deployFor(cfg, workspaceName) {
  const raw = (cfg.deploys || {})[workspaceName];
  if (!raw || typeof raw !== 'object') return null;

  let dir = raw.dir ? String(raw.dir) : null;
  if (!dir) {
    // The same checkout every session for this workspace opens in. A workspace with
    // no directory at all cannot be deployed, and says so rather than defaulting to
    // somewhere plausible — `~` has been somewhere plausible before now.
    const ws = (cfg.workspaces || []).find((w) => w.name === workspaceName) || { name: workspaceName };
    dir = resolveSessionDir(cfg, ws);
  }
  dir = path.resolve(dir);

  const base = String(raw.base || cfg.pr?.base || 'main');
  const vars = { uid: currentUid(), home: os.homedir(), dir, base };

  const rebuild = (Array.isArray(raw.rebuild) ? raw.rebuild : []).map((r, i) => ({
    // Path prefixes, matched against what the fast-forward actually moved — so an APK
    // is rebuilt when `android/` moved and not when a comment in lib/ did. No `when`
    // at all means every time, which is a legitimate thing to declare for a repo whose
    // build is cheap, and the honest reading of having named no condition.
    when: Array.isArray(r?.when) ? r.when.map(String) : [],
    command: argv(r?.command, vars, `deploys.${workspaceName}.rebuild[${i}].command`),
    label: r?.label ? String(r.label) : 'rebuild',
  }));

  return {
    workspace: workspaceName,
    dir,
    base,
    command: argv(raw.command, vars, `deploys.${workspaceName}.command`),
    // Bring the checkout up to date before deploying, so what goes live is the merged
    // tree rather than whatever this Mac happened to have. Fast-forward only, and it
    // refuses over uncommitted work — see the runner.
    pull: raw.pull !== false,
    rebuild,
    // Does this deploy restart beadcause itself? It changes only how an interrupted
    // runner is *read*: for a restart, being killed at the deploy step is the normal
    // ending and means "it ran, nobody outlived it to confirm"; anywhere else it means
    // the runner was lost. Declared rather than sniffed, because a wrong guess here is
    // the difference between `unconfirmed` and `lost`.
    restarts: Boolean(raw.restarts),
    graceMs: Number.isFinite(raw.graceMs) ? Math.max(0, raw.graceMs) : DEFAULT_GRACE_MS,
    timeoutMs: Number.isFinite(raw.timeoutMs) ? Math.max(1000, raw.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

/** Every workspace with a deploy this daemon could run, for a screen that asks. */
export function deployable(cfg) {
  return (cfg.workspaces || [])
    .map((w) => {
      try {
        return deployFor(cfg, w.name) ? w.name : null;
      } catch {
        // A broken declaration is not "deployable", but it must not take the list
        // down with it — the other repos' buttons are unaffected by this one's typo.
        return null;
      }
    })
    .filter(Boolean);
}

/* -------------------------------------------------------------------- journal */

const recordPath = (id) => path.join(DEPLOY_DIR, `${id}.json`);
const markPath = (id) => path.join(DEPLOY_DIR, `${id}.announced`);
export const logPath = (id) => path.join(DEPLOY_DIR, `${id}.log`);

function readRecord(id) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
    return rec && typeof rec === 'object' && rec.id === id ? rec : null;
  } catch {
    // Half-written, hand-mangled, or gone. A record we cannot read is not a deploy
    // that succeeded, and the honest thing is to leave it out of the list rather than
    // to invent fields for it.
    return null;
  }
}

/** Newest first. Unreadable records are omitted; there is nothing true to say. */
export function listDeploys({ limit = KEEP } = {}) {
  let names;
  try {
    names = fs.readdirSync(DEPLOY_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readRecord(n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, limit);
}

export const showDeploy = (id) => (/^[\w.-]+$/.test(String(id)) ? readRecord(String(id)) : null);

/** The tail of a runner's own output, for a screen that wants to see why. */
export function deployLog(id, { bytes = 16384 } = {}) {
  if (!/^[\w.-]+$/.test(String(id))) return '';
  try {
    const buf = fs.readFileSync(logPath(id));
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** Is that pid still there? `false` only when we are sure it is not. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process with that pid exists and belongs to someone else. That is
    // not our runner, but it is not evidence our runner is gone either — and calling
    // it gone would let pid reuse turn an unknown into a verdict.
    return err.code === 'EPERM';
  }
}

/**
 * How long a record may sit with no pid on it before it counts as never started.
 *
 * There is one unavoidable gap in the handover: the parent writes the record, spawns,
 * and from that instant the file belongs to the child — so the *child* writes the pid,
 * because a parent writing it afterwards would clobber whatever the child had already
 * recorded. Between those two moments the record is pid-less and perfectly healthy.
 * Thirty seconds is far longer than an exec takes and far shorter than anybody waits;
 * past it, `node` did not come up and that is a real failure worth naming.
 */
const STARTUP_GRACE_MS = 30000;

/**
 * Is this record's runner still on the job?
 *
 * The pid-less window above is the whole subtlety: "no pid yet" has to read as alive
 * for a moment and as lost thereafter, or every deploy is either declared dead the
 * instant it starts or never declared dead at all.
 */
function running(rec) {
  if (!LIVE.has(rec.status)) return false;
  if (rec.pid == null) return Date.now() - Date.parse(rec.requestedAt || 0) < STARTUP_GRACE_MS;
  return pidAlive(rec.pid);
}

/**
 * Settle every record whose runner is no longer there.
 *
 * Run at boot and on the poll, and it is the whole of "a failed deploy does not
 * silently read as success". A deploy that restarts beadcause is *expected* to end
 * this way — launchd takes the job's processes and the runner is one of them — so
 * that ending gets its own word, `unconfirmed`, which says the command ran and
 * nothing survived to report on it. Every other disappearance is `lost`.
 *
 * Only ever writes a record whose pid is confirmed dead, which is what keeps "the
 * runner owns its file" true.
 */
export function sweepDeploys() {
  const changed = [];
  for (const rec of listDeploys({ limit: 200 })) {
    if (!LIVE.has(rec.status)) continue;
    if (running(rec)) continue;
    const restartEnding = rec.status === 'deploying' && rec.restarts;
    const settled = {
      ...rec,
      status: restartEnding ? 'unconfirmed' : 'lost',
      finishedAt: rec.finishedAt || iso(),
      error: restartEnding
        ? 'The deploy command ran and the runner did not outlive it — which is what a restart looks like from here. Whether it worked is a question for the running build, not for this record.'
        : rec.pid == null
          ? 'The runner never started: no process ever claimed this deploy.'
          : `The runner disappeared at "${rec.status}" without recording an outcome.`,
    };
    try {
      writeJsonAtomic(recordPath(rec.id), settled);
      changed.push(settled);
    } catch {
      /* the directory may have been swept from under us; nothing useful to do */
    }
  }
  return changed;
}

/**
 * Settled deploys nobody has been told about yet.
 *
 * A marker file rather than a field on the record, because the record belongs to the
 * runner and this is the daemon's bookkeeping — and because it has to survive the
 * daemon being replaced mid-deploy by the deploy itself, which is precisely the case
 * where the notification matters most.
 */
export function unannounced() {
  return listDeploys({ limit: 200 })
    .filter((r) => !LIVE.has(r.status))
    .filter((r) => !fs.existsSync(markPath(r.id)))
    .reverse();
}

export function markAnnounced(id) {
  try {
    fs.mkdirSync(DEPLOY_DIR, { recursive: true });
    fs.writeFileSync(markPath(id), `${iso()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Keep the directory to the last `KEEP` deploys, markers and logs with them. */
function prune() {
  let names;
  try {
    names = fs.readdirSync(DEPLOY_DIR);
  } catch {
    return;
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) {
    const rec = readRecord(id);
    if (rec && running(rec)) continue;
    for (const p of [recordPath(id), markPath(id), logPath(id)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Is a deploy already in flight for this repo? Returns it, so the caller can say so. */
export function runningFor(workspaceName) {
  return listDeploys({ limit: 200 }).find((r) => r.workspace === workspaceName && running(r)) || null;
}

/* --------------------------------------------------------------------- start */

/**
 * Start a deploy and return immediately.
 *
 * The contract, in the order it has to happen: whatever made this deploy worth doing
 * is already durable — the merge, the answer, the closed bead — *before* this is
 * called. Nothing here writes to beads or to a question, deliberately, because a
 * process that may be SIGKILLed inside the next second is the wrong one to be holding
 * the only copy of anything.
 *
 * What comes back is the record, which is on disk before the child is spawned. So a
 * deploy that kills this process a moment later is still a deploy that is written
 * down, with the reason it was asked for and the bead that asked.
 */
export function startDeploy(cfg, workspaceName, { bead = null, reason = '', graceMs = null } = {}) {
  const plan = deployFor(cfg, workspaceName);
  if (!plan) throw Object.assign(new Error(`no deploy is declared for ${workspaceName}`), { status: 409 });

  const already = runningFor(workspaceName);
  if (already) throw Object.assign(new Error(`a deploy of ${workspaceName} is already running (${already.id})`), { status: 409 });

  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  prune();

  const id = `d-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id,
    workspace: workspaceName,
    dir: plan.dir,
    base: plan.base,
    bead: bead || null,
    reason: String(reason || ''),
    restarts: plan.restarts,
    status: 'queued',
    requestedAt: iso(),
    startedAt: null,
    finishedAt: null,
    heartbeatAt: iso(),
    pid: null,
    from: null,
    to: null,
    changed: [],
    steps: [],
    error: null,
    plan: {
      pull: plan.pull,
      command: plan.command,
      rebuild: plan.rebuild,
      timeoutMs: plan.timeoutMs,
      graceMs: graceMs === null ? plan.graceMs : Math.max(0, graceMs),
    },
  };
  writeJsonAtomic(recordPath(id), record);

  // Detached, with its own session, and its output on a file rather than on a pipe
  // this process owns. All three are the same requirement: the child has to outlive
  // its parent, and a parent that is about to be SIGKILLed cannot be holding the
  // other end of anything the child still needs.
  const out = fs.openSync(logPath(id), 'a', 0o600);
  const child = spawn(process.execPath, [RUNNER, recordPath(id)], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: plan.dir,
    env: { ...process.env },
  });
  child.unref();
  try {
    fs.closeSync(out);
  } catch {
    /* the child holds its own descriptor now */
  }

  // The record on disk is the runner's from the spawn onwards, and it writes its own
  // pid first thing — so nothing is written back here. The pid on the returned object
  // is for this process's log line and for the response; it is deliberately not the
  // record, because a write from here would land on top of whatever the child had
  // already recorded and the loser of that race would be the truth.
  return { ...record, pid: child.pid };
}
