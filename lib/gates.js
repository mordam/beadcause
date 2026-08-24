/**
 * Which gate runners are on this Mac, whose worktree each one is in, and ending only mine.
 *
 * `bin/b7e-gates` is the argv shell; this is the primitive four sessions each rebuilt by
 * hand (bc-khoe.55, quoting bc-4r10.13, bc-khoe.4, bc-khoe.30.14, bc-khoe.53): on a
 * machine where ~30 worktrees of this repo are live and several may be running
 * `scripts/test.mjs` or `scripts/coverage.mjs` at once, which running process is *mine*?
 * Two of the four got it wrong first, and the one answer that actually worked every time
 * was `lsof -a -p <pid> -d cwd -Fn` — nothing else can say which worktree a pid's cwd
 * resolves to.
 *
 * ## Two ways a runner is found, and this always tries the cheap one first
 *
 * `b7e-gate` (bc-khoe.39) already writes a lock file per tree — `gateLockStatus`
 * (`lib/gate.js`) reads it back. For any run that went through that lock, "which
 * worktree is this pid in" is a file read, keyed by the worktree root itself: no `lsof`,
 * no false hit from an agent process whose own prompt text happens to contain the words
 * `scripts/coverage.mjs`. That does not cover everything, though — the four sessions in
 * the bead were killing `scripts/test.mjs` and `scripts/coverage.mjs` started *directly*
 * (`npm test` by hand is the common case), which take no lock and are only identifiable
 * by `cwd`. So every process table match that is not already accounted for by a lock
 * falls back to `lsof`, and each runner in the report says which of the two told us.
 *
 * ## Failing closed
 *
 * `cwdOf` returns `null` when the pid is simply gone (an ordinary race between `ps` and
 * `lsof`) and `undefined` when it could not be determined at all — no `lsof` binary, or
 * a refusal `lsof` itself did not explain. `undefined` must never be read as "not mine":
 * a runner it happens to is reported `unresolved` rather than silently dropped or
 * silently kept, and `--end-mine` never signals one. Guessing in the permissive
 * direction is exactly the mistake this file exists to stop being made by hand.
 *
 * ## Ending one, and the bc-khoe.30.14 trap
 *
 * bc-khoe.30.14's own `pkill -f 'scripts/test.mjs'` "succeeded" and killed nothing: the
 * detached child of a `spawnSync`'d suite survived its parent's death and kept running,
 * ownerless, under a pid nothing was watching any more. `endRunner` does not trust a
 * cascade to clean that up — it snapshots the *whole* descendant tree of the runner's
 * pid before sending anything, signals every pid in it directly, waits, and reports
 * which of them are still alive afterward rather than trusting the exit status of the
 * first signal sent. A runner is not "ended" until this says so.
 *
 * ## Every external read is injectable
 *
 * `discover`'s `deps` bag overrides `listWorktrees`/`psTable`/`ppidTable`/`cwdOf`/
 * `gateLockStatus` one at a time, the same shape `lib/strays.js`'s `listChromes({ps})`
 * already uses for the same reason: `test/gates.mjs` drives the whole report and the
 * whole kill path against fabricated process tables, never a real one.
 */
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, gateLockStatus as realGateLockStatus } from './gate.js';
import { parseWorktrees, realPath } from './tidy.js';
import { elapsedMs } from './strays.js';

export { REPO_ROOT };

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ worktrees */

/** `git worktree list --porcelain`, parsed, with each path also carrying its `realpath`. */
export async function listWorktrees(dir = REPO_ROOT) {
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return parseWorktrees(out).map((w) => ({ ...w, real: realPath(w.path) }));
}

/**
 * The nearest worktree `cwd` is inside, or is exactly — never a substring match, so a
 * worktree named `foo` cannot claim a sibling named `foo-2`. `null` if `cwd` is outside
 * every one of them (a `git worktree remove` between the two reads, most likely).
 */
export function worktreeFor(cwd, worktrees) {
  if (!cwd) return null;
  const real = realPath(cwd);
  let best = null;
  for (const w of worktrees) {
    if (real === w.real || real.startsWith(`${w.real}${path.sep}`)) {
      if (!best || w.real.length > best.real.length) best = w;
    }
  }
  return best;
}

/* --------------------------------------------------------------------------- runners */

/** The top-level scripts a gate runs as — matched against the whole command line. */
export const RUNNER_PATTERNS = [
  { name: 'test.mjs', re: /(?:^|\/)scripts\/test\.mjs(?:\s|$)/ },
  { name: 'coverage.mjs', re: /(?:^|\/)scripts\/coverage\.mjs(?:\s|$)/ },
  { name: 'checks.mjs', re: /(?:^|\/)scripts\/checks\.mjs(?:\s|$)/ },
  { name: 'b7e-gate', re: /(?:^|\/)bin\/b7e-gate(?:\s|$)/ },
];

/** `--match <pattern>` adds one more, tried last and named `other` — a scratchpad runner. */
export function withMatch(patterns, match) {
  if (!match) return patterns;
  return [...patterns, { name: 'other', re: new RegExp(match) }];
}

/** One `ps -Ao pid=,etime=,command=` line → `{ pid, etime, command }`, or `null`. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), etime: m[2], command: m[3] };
}

/** Every process on the machine, cheaply — one call, reused for every question below. */
export async function psTable() {
  const { stdout } = await run('ps', ['-Ao', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return String(stdout).split('\n').map(parsePsLine).filter(Boolean);
}

/** `pid -> ppid`, for finding a runner's descendants — see `descendantsOf`. */
export async function ppidTable() {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const map = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** `pid` and every descendant of it, from a `pid -> ppid` map — a fresh read, never stale. */
export function descendantsOf(pid, ppids) {
  const children = new Map();
  for (const [child, parent] of ppids) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const out = [pid];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of children.get(p) || []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/** The script a `ps` command line is running, relative to `root` when it is under it. */
export function suiteNameFor(command, root) {
  const scriptArg = String(command)
    .split(/\s+/)
    .find((a) => /\.(?:mjs|js)$/.test(a));
  if (!scriptArg) return null;
  const rel = path.relative(root, path.resolve(scriptArg));
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : scriptArg;
}

/** Where to look for `lsof` — same search, same reason, as `lib/gitref.js`'s own. */
function lsofCandidates() {
  const named = process.env.BEADCAUSE_LSOF;
  return named ? [named] : ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'];
}

let saidNoLsof = false;

/**
 * A pid's current working directory. `null` — the pid is simply gone (an ordinary race
 * between `ps` and here). `undefined` — could not be determined at all. See the header
 * for why the caller must never read `undefined` as "not mine".
 */
export async function cwdOf(pid) {
  const candidates = lsofCandidates();
  for (const lsof of candidates) {
    try {
      const { stdout } = await run(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 10000 });
      const line = String(stdout)
        .split('\n')
        .find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    } catch (err) {
      if (err?.code === 1 && !String(err.stdout || '').trim()) return null;
      if (err?.code === 'ENOENT') continue;
      return undefined;
    }
  }
  if (!saidNoLsof) {
    saidNoLsof = true;
    console.error(
      `[beadcause] b7e-gates: cannot resolve a pid's cwd — no lsof at ${candidates.join(', ')}. ` +
        'Runners outside a b7e-gate lock are reported unresolved rather than guessed at.',
    );
  }
  return undefined;
}

/** The suites (relative to `root`) currently running as direct children of `pid`. */
async function suitesUnder(pid, root, { ppidTable: ppidTableFn, psTable: psTableFn }) {
  const ppids = await ppidTableFn();
  const kids = [...ppids.entries()].filter(([, parent]) => parent === pid).map(([child]) => child);
  if (!kids.length) return [];
  const rows = await psTableFn();
  const byPid = new Map(rows.map((r) => [r.pid, r.command]));
  const out = [];
  for (const kid of kids) {
    const command = byPid.get(kid);
    if (!command) continue;
    const name = suiteNameFor(command, root);
    if (name) out.push(name);
  }
  return out;
}

/**
 * The whole report: every worktree, which one is `dir` (the caller's own — `--mine`
 * tags against this), and every gate runner found, `b7e-gate` locks first and the
 * `ps`+`lsof` fallback after — see the header for why that order and why each source is
 * named on the runner it found.
 */
export async function discover({ dir = process.cwd(), match, now = Date.now(), root, deps = {} } = {}) {
  const listWorktreesFn = deps.listWorktrees || listWorktrees;
  const psTableFn = deps.psTable || psTable;
  const ppidTableFn = deps.ppidTable || ppidTable;
  const cwdOfFn = deps.cwdOf || cwdOf;
  const gateLockStatusFn = deps.gateLockStatus || realGateLockStatus;

  const worktrees = await listWorktreesFn(root || dir);
  const mineWorktree = worktreeFor(dir, worktrees);
  const patterns = withMatch(RUNNER_PATTERNS, match);
  const table = { ppidTable: ppidTableFn, psTable: psTableFn };

  const runners = [];
  const lockedPids = new Set();

  for (const wt of worktrees) {
    const status = gateLockStatusFn(wt.path);
    if (!status) continue;
    lockedPids.add(status.pid);
    runners.push({
      pid: status.pid,
      runner: 'b7e-gate',
      source: 'lock',
      startedAt: status.startedAt,
      ageMs: now - status.startedAt,
      worktree: wt,
      suites: await suitesUnder(status.pid, wt.real, table),
      unresolved: false,
    });
  }

  const rows = await psTableFn();
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    if (lockedPids.has(row.pid)) continue;
    const hit = patterns.find((p) => p.re.test(row.command));
    if (!hit) continue;
    const ageMs = elapsedMs(row.etime);
    const cwd = await cwdOfFn(row.pid);
    if (cwd === null) continue; // gone between the ps read and the lsof read
    const worktree = cwd === undefined ? null : worktreeFor(cwd, worktrees);
    runners.push({
      pid: row.pid,
      runner: hit.name,
      source: 'pgrep',
      startedAt: ageMs == null ? null : now - ageMs,
      ageMs,
      worktree,
      suites: await suitesUnder(row.pid, worktree ? worktree.real : REPO_ROOT, table),
      unresolved: cwd === undefined,
    });
  }

  const tagged = runners.map((r) => ({
    ...r,
    mine: !!(r.worktree && mineWorktree && r.worktree.path === mineWorktree.path),
  }));
  return { worktrees, mine: mineWorktree, runners: tagged };
}

/* --------------------------------------------------------------------------- ending */

/** Is a pid still there? `EPERM` is a *yes* — it exists and belongs to someone else. */
function isAlive(pid, send) {
  try {
    send(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * End one runner, verified. Snapshots the whole descendant tree of `runner.pid` *before*
 * signalling anything — the bc-khoe.30.14 fix: a child that would otherwise survive its
 * parent's death is signalled directly, not left to a cascade that may not happen.
 * SIGTERM every pid in the tree, wait `graceMs`, SIGKILL whatever is still there, wait
 * once more, then report which pids are still alive. `ok` is `survivors.length === 0` —
 * the only thing this file is willing to call "ended".
 */
export async function endRunner(runner, { graceMs = 2000, signal, sleep: sleepFn = sleep, ppidTable: ppidTableFn = ppidTable } = {}) {
  const send = signal || ((pid, sig) => process.kill(pid, sig));
  const table = await ppidTableFn();
  const targets = descendantsOf(runner.pid, table);

  const sent = [];
  const refused = [];
  for (const pid of targets) {
    try {
      send(pid, 'SIGTERM');
      sent.push(pid);
    } catch (err) {
      if (err.code !== 'ESRCH') refused.push({ pid, why: err.code || err.message });
    }
  }

  if (sent.length) await sleepFn(graceMs);
  const escalated = [];
  for (const pid of sent) {
    if (!isAlive(pid, send)) continue;
    escalated.push(pid);
    try {
      send(pid, 'SIGKILL');
    } catch {
      /* gone between the two checks, which is the outcome wanted */
    }
  }
  if (escalated.length) await sleepFn(Math.min(graceMs, 1000));

  const survivors = targets.filter((pid) => isAlive(pid, send));
  return { pid: runner.pid, targets, sent, refused, escalated, survivors, ok: survivors.length === 0 };
}

/* ------------------------------------------------------------------------- reporting */

export const mineCount = (runners) => runners.filter((r) => r.mine).length;

/** Which of `runners` tagged `mine` to spare when `--stale` is given — the newest one. */
export function newestMine(runners) {
  const mine = runners.filter((r) => r.mine);
  if (!mine.length) return null;
  return mine.reduce((newest, r) => {
    if (!newest) return r;
    if (r.startedAt == null) return newest;
    if (newest.startedAt == null) return r;
    return r.startedAt > newest.startedAt ? r : newest;
  }, null);
}

/** A one-line reason to be careful, or `null` — printed last, after every runner line. */
export function hazardLine(runners) {
  const n = mineCount(runners);
  if (n > 1) {
    return (
      `${n} gates are running in this worktree at once — this repo's own notes say ` +
      'two concurrent gates here produce false reds; --end-mine --stale keeps the newest.'
    );
  }
  const unresolved = runners.filter((r) => r.unresolved).length;
  if (unresolved) {
    return (
      `${unresolved} runner${unresolved === 1 ? '' : 's'} could not be matched to a worktree — ` +
      'no lsof, so ownership is unknown rather than assumed; none of them can be ended with --end-mine.'
    );
  }
  return null;
}

/** `0` ordinarily, `1` when more than one runner is mine — the acceptance criteria's own rule. */
export const exitCodeFor = (runners) => (mineCount(runners) > 1 ? 1 : 0);

export function formatRunner(r) {
  const who = r.mine ? 'MINE' : r.worktree ? r.worktree.path : r.unresolved ? 'unresolved' : 'gone';
  const started = r.startedAt ? new Date(r.startedAt).toISOString() : 'unknown';
  const age = r.ageMs != null ? `${Math.round(r.ageMs / 1000)}s` : '?';
  const suites = r.suites && r.suites.length ? ` running ${r.suites.join(', ')}` : '';
  return `pid ${r.pid}  ${r.runner}  [${r.source}]  started ${started}  elapsed ${age}  ${who}${suites}`;
}
