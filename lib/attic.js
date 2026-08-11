/**
 * Emptying the attic — the third act of the retirement convention.
 *
 * `lib/tidy.js` is the first two acts: it decides a worktree is finished and
 * `git worktree move`s it into `.claude/worktrees-retired/` instead of deleting it, so
 * it stays resumable with its untracked and ignored files intact. That is a *soft*
 * delete, and a soft delete nobody hardens is a directory that grows forever — the
 * attic reached 51 entries and 1.0 GB before anyone counted. This file is what empties
 * it: once a retired worktree is older than the expiry (Adam set it at 2 days) it has
 * outlived its resumability and goes for good, subject to the same state gates the
 * retirement itself used.
 *
 * ## Why it is in here rather than in the ship skill
 *
 * It was a 210-line bash script in `~/.claude-personal/skills/ship/`, versioned by
 * nothing and tested by nothing, run by every ship. bc-bcdp is what that cost. One
 * line of it — `git worktree list --porcelain | grep -qx "worktree $dir"` under
 * `set -o pipefail`, where `grep -q` exits at the first match, git dies of SIGPIPE
 * still walking the rest, and pipefail reports the *successful* match as failure —
 * reported 68 of 85 healthy attic entries as unregistered strays, with the count
 * moving run to run. A session read that output, believed it, and filed a bug
 * describing a hand-`mv` that never happened. Nothing stood between the script and
 * the person reading it.
 *
 * So the sweep lives beside the writer it mirrors, its gates run under `npm test`, and
 * the ship skill calls one thing instead of keeping its own copy of the logic. It is
 * still repo-agnostic — `sweepAttic()` takes a main checkout and beadcause and sophab
 * share the convention — it just has a test suite now.
 *
 * ## The gates
 *
 * An entry is removed only when **all** hold. Any failure means keep it and say why:
 *
 * - **age** ≥ `days`, from the `.note` sidecar's ISO-8601 UTC stamp. Age alone is
 *   emphatically not enough: on the day the sweep was written exactly one retiree was
 *   not an ancestor of `main`, and pruning it on age would have destroyed the only copy
 *   of its commits.
 * - **unlocked** — a lock is a live session's claim on it, and claims are honoured.
 * - **merged** — contained in `origin/main`, or in local `main` for a repo with no
 *   remote. Unmerged means the commits die with the directory.
 * - **clean** of *tracked* modifications. Untracked and ignored files are expected;
 *   carrying them along is the whole point of a move.
 * - **unclaimed** — no live handoff under `.claude/handoffs/` names it.
 *
 * Removal is `git worktree remove`, never `rm -rf`: every entry is still a *registered*
 * worktree, and an `rm` leaves a dangling registration only `git worktree prune`
 * clears. The branch is kept — the directory is a checkout, the ref is the only
 * human-readable label on that thread's commits.
 *
 * Nothing here ever deletes something it does not understand. An unregistered directory
 * in the attic, or a `.note` whose directory is gone, is *reported* and left alone:
 * that means someone moved things by hand, and guessing is how you lose work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWorktrees } from './tidy.js';

const run = promisify(execFile);

const RETIRED = path.join('.claude', 'worktrees-retired');
const HANDOFFS = path.join('.claude', 'handoffs');

/** Adam's expiry, set 2026-08-09: the point at which nobody is going to resume it. */
export const DEFAULT_DAYS = 2;

/**
 * git, never through a shell, and answering with a status rather than an exception.
 *
 * Half the gates below *are* exit codes — `merge-base --is-ancestor` says no by exiting
 * 1 — so a helper that threw would turn every answer into a try/catch and every
 * forgotten catch into a sweep that died mid-attic.
 */
async function git(cwd, args, { timeout = 20000 } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: stdout, err: '' };
  } catch (err) {
    return { ok: false, out: err.stdout || '', err: String(err.stderr || err.message || '').trim() };
  }
}

/**
 * The `.note` stamp → epoch ms, or null if it is not one.
 *
 * Two writers fill this attic and they disagree on precision: `ship` step 8 shells out
 * to `date -u +%FT%TZ` and writes whole seconds (`2026-08-09T23:31:04Z`), while
 * lib/tidy.js retires worktrees on its own via `toISOString()` and writes milliseconds
 * (`2026-08-08T17:35:33.804Z`). Same one-line shape, same meaning — so drop any
 * fractional part rather than treating half the attic as unparseable. A third writer
 * is welcome as long as the first field is an ISO-8601 UTC stamp and nothing else.
 */
export function parseStamp(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(String(stamp || '').trim());
  if (!m) return null;
  const at = Date.parse(`${m[1]}Z`);
  return Number.isFinite(at) ? at : null;
}

/** First whitespace-delimited field of the first line, which is where the stamp is. */
function stampIn(noteFile) {
  try {
    const first = fs.readFileSync(noteFile, 'utf8').split('\n', 1)[0];
    return first.trim().split(/\s+/)[0] || '';
  } catch {
    return '';
  }
}

const under = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * The main checkout of the repo containing `dir`, and whether `dir` *is* it.
 *
 * `git worktree remove` on a sibling from inside a worktree does work, but the whole
 * vocabulary here is main-checkout-relative and a worktree cwd is how you end up
 * removing the tree you are standing in. So the sweep refuses rather than adapts.
 */
async function locate(dir) {
  const own = await git(dir, ['rev-parse', '--absolute-git-dir']);
  if (!own.ok) throw new Error(`not a git repo: ${dir}`);
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) throw new Error(`not a git repo: ${dir}`);
  const gitDir = path.resolve(own.out.trim());
  const commonDir = path.resolve(common.out.trim());
  const main = path.dirname(commonDir);
  if (gitDir !== commonDir) throw new Error(`${dir} is a worktree, not the main checkout — run this from ${main}`);
  return main;
}

/**
 * Is this branch already contained in main — and is `main` even the right ref to ask?
 *
 * It is not, on any repo where merging happens on github.com. `origin/main` moves and
 * the local `main` branch stays wherever the last `git pull` left it: on beadcause that
 * gap was fifty commits, and eight retired worktrees were reported as "NOT merged into
 * main" over work that had shipped two days earlier — which reads as the sweep
 * protecting them and is really the sweep being told a stale fact.
 *
 * `origin/main` first, local `main` as the fallback for a repo with no remote, and each
 * only when it exists. Wrong in the safe direction either way: a ref that has not been
 * fetched answers "no" and the entry survives another day.
 */
async function containedInMain(main, branch, refs) {
  for (const ref of refs) {
    if ((await git(main, ['merge-base', '--is-ancestor', branch, ref])).ok) return true;
  }
  return false;
}

async function mainRefs(main) {
  const refs = [];
  for (const ref of ['origin/main', 'main']) {
    if ((await git(main, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) refs.push(ref);
  }
  return refs;
}

/**
 * Every live handoff's text, read once.
 *
 * Once, not once per entry: an 85-entry attic against a handoffs directory is 85 walks
 * of the same files, and one capture is the same fix the stray scan needed. `archive/`
 * is spent by definition and excluded at any depth.
 *
 * Membership is a substring test, as the `grep -rl` it replaces was — so a handoff
 * naming `foo` also holds `foo-2`. That is the safe direction: an extra directory
 * costs a ship nothing, and the session that comes looking for one that isn't there
 * loses its thread.
 */
function handoffText(main) {
  const out = [];
  const stack = [path.join(main, HANDOFFS)];
  while (stack.length) {
    let entries;
    const dir = stack.pop();
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'archive') stack.push(p);
        continue;
      }
      try {
        out.push(fs.readFileSync(p, 'utf8'));
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return out;
}

/** Directories in the attic, by name. `.note` sidecars are files and not among them. */
function atticDirs(retiredRoot) {
  try {
    return fs
      .readdirSync(retiredRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function atticNotes(retiredRoot) {
  try {
    return fs
      .readdirSync(retiredRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.note'))
      .map((e) => e.name.slice(0, -'.note'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write a `.note` for entries retired before the convention existed.
 *
 * Directory mtime is the only signal left, and it is a *late* proxy — it tracks the
 * last content change, never anything earlier than the retirement — so a backfilled
 * entry can only survive longer than it should, never be pruned sooner.
 *
 * A dry run writes nothing, and still returns the stamps: the age gate consults these
 * before it looks on disk, so `--dry-run --backfill` answers the question it is actually
 * being asked — what would go once these entries had stamps — without having written
 * one. The bash version it replaces backfilled for real under `--dry-run`, which is a
 * dry run with a side effect.
 */
function backfillNotes(retiredRoot, { dryRun = false } = {}) {
  const done = [];
  for (const name of atticDirs(retiredRoot)) {
    const note = path.join(retiredRoot, `${name}.note`);
    if (fs.existsSync(note)) continue;
    let mtime;
    try {
      mtime = fs.statSync(path.join(retiredRoot, name)).mtime;
    } catch {
      continue;
    }
    const stamp = `${mtime.toISOString().replace(/\.\d+Z$/, 'Z')}`;
    if (!dryRun) {
      fs.writeFileSync(note, `${stamp}  retired (backfilled from directory mtime, exact date unknown)\n`, { mode: 0o644 });
    }
    done.push({ name, stamp });
  }
  return done;
}

/**
 * Sweep one repo's attic. Returns what went, what stayed and why, and what it refused
 * to touch — never throwing for anything it found, only for how it was called.
 *
 * `now` is injectable because every gate here is a date comparison and a test that has
 * to `touch` its way to four days old is a test nobody writes.
 */
export async function sweepAttic(dir, { days = DEFAULT_DAYS, dryRun = false, backfill = false, now = Date.now() } = {}) {
  const main = await locate(dir);
  const retiredRoot = path.join(main, RETIRED);
  const result = {
    main,
    retiredRoot,
    days,
    dryRun,
    backfill,
    ran: false,
    backfilled: [],
    removed: [],
    skipped: [],
    young: [],
    strays: [],
  };
  if (!fs.existsSync(retiredRoot)) return result;
  result.ran = true;

  if (backfill) result.backfilled = backfillNotes(retiredRoot, { dryRun });
  // Written or only proposed, these are the stamps the age gate below should use.
  const proposed = new Map(result.backfilled.map((b) => [b.name, b.stamp]));

  const cutoff = days * 86400000;
  const refs = await mainRefs(main);
  const handoffs = handoffText(main);

  // One listing, walked once. A registered worktree is the only thing
  // `git worktree remove` can act on, and a stray directory in the attic is a
  // different problem — reported below, never deleted.
  const list = parseWorktrees((await git(main, ['worktree', 'list', '--porcelain'])).out);

  for (const wt of list) {
    const wtPath = path.resolve(wt.path);
    if (!under(wtPath, path.resolve(retiredRoot))) continue;
    const name = path.basename(wtPath);
    const note = path.join(retiredRoot, `${name}.note`);

    // --- age
    let ageDays = null;
    let why = '';
    let young = false;
    if (proposed.has(name) || fs.existsSync(note)) {
      const stamp = proposed.get(name) ?? stampIn(note);
      const at = parseStamp(stamp);
      if (at === null) {
        why = `unparseable .note stamp: ${stamp}`;
      } else {
        const old = now - at;
        ageDays = old / 86400000;
        if (old < cutoff) {
          young = true;
          why = `younger than ${days}d`;
        }
      }
    } else {
      why = 'no .note — run with --backfill';
    }

    // --- state gates, in the order a failure is most likely and most serious
    if (!why) {
      if (wt.locked) {
        why = 'LOCKED — a live session is in it';
      } else if (wt.detached || !wt.branch) {
        why = 'detached HEAD — no branch to check ancestry against';
      } else if (!(await containedInMain(main, wt.branch, refs))) {
        why = 'NOT merged into main — removing it destroys its only copy';
      } else if (await dirtyTracked(wtPath)) {
        why = 'dirty — uncommitted tracked edits exist nowhere else';
      } else if (handoffs.some((text) => text.includes(name))) {
        why = 'named by a live handoff';
      }
    }

    if (why) {
      (young ? result.young : result.skipped).push({ name, ageDays, why });
      continue;
    }

    if (dryRun) {
      result.removed.push({ name, ageDays, branch: wt.branch, why: `would remove (${wt.branch})`, dryRun: true });
      continue;
    }

    // `--force` for exactly one reason: `git worktree remove` refuses a worktree
    // carrying *untracked* files, and a retired worktree is allowed to carry them —
    // that is what the soft delete is for. Without it such an entry passes every gate
    // above and then loses to git on the last line, forever; two of beadcause's 105
    // were stuck there. It is not a loosened gate: one `--force` covers the unclean
    // case only (a locked worktree needs two, and the lock gate above means this never
    // sees one), and tracked edits and unmerged commits were both refused several
    // gates earlier on their own evidence.
    const gone = await git(main, ['worktree', 'remove', '--force', wtPath]);
    if (gone.ok) {
      fs.rmSync(note, { force: true });
      result.removed.push({ name, ageDays, branch: wt.branch, why: `removed (${wt.branch} kept)` });
    } else {
      result.skipped.push({ name, ageDays, why: `git worktree remove refused: ${gone.err.split('\n')[0]}` });
    }
  }

  // Stray directories and orphan notes: report, never delete.
  //
  // Re-listed after the removal loop, not before: a removal above retires a
  // registration, and scanning against a listing taken beforehand would call every
  // just-removed entry stray.
  const registered = new Set(
    parseWorktrees((await git(main, ['worktree', 'list', '--porcelain'])).out).map((w) => path.resolve(w.path))
  );
  for (const name of atticDirs(retiredRoot)) {
    if (!registered.has(path.resolve(path.join(retiredRoot, name)))) {
      result.strays.push({ name, ageDays: null, why: 'not a registered worktree — inspect by hand' });
    }
  }
  for (const name of atticNotes(retiredRoot)) {
    if (!fs.existsSync(path.join(retiredRoot, name))) {
      result.strays.push({ name: `${name}.note`, ageDays: null, why: 'orphan .note, directory already gone' });
    }
  }

  return result;
}

/**
 * Tracked modifications only.
 *
 * `--untracked-files=no` is the gate, not an optimisation: a retired worktree is
 * *expected* to be carrying untracked and ignored files, and counting them would keep
 * every entry in the attic forever.
 *
 * A status that cannot be read at all means the directory is gone from under its
 * registration, which is not a reason to keep it — `git worktree remove` is precisely
 * what clears that, so it falls through to the removal as clean.
 */
async function dirtyTracked(wtPath) {
  const st = await git(wtPath, ['status', '--porcelain', '--untracked-files=no']);
  return st.ok && st.out.split('\n').some((l) => l.trim());
}

/**
 * The report: one line plus a row per exception, because the common case is boring.
 *
 * Entries that are simply not old enough yet are the bulk of the attic and get a count
 * rather than a row each, or the sweep drowns the ship report it lives in.
 */
export function describeAttic(result) {
  const lines = [];
  const row = (verb, e) => lines.push(`  ${pad(verb, 9)} ${pad(e.name, 34)} ${lpad(age(e.ageDays), 5)}  ${e.why}`);

  for (const b of result.backfilled) lines.push(`  backfilled  ${b.name}  ${b.stamp}`);
  // Only when a backfill was asked for — "backfilled 0 note(s)" on every ordinary
  // sweep is a line that says nothing, and this report is read inside a longer one.
  if (result.backfill) lines.push(`backfilled ${result.backfilled.length} note(s)`);

  if (!result.ran) {
    lines.push('attic sweep: no .claude/worktrees-retired/ — nothing to do');
    return lines;
  }

  const verb = result.dryRun ? 'would remove' : 'removed';
  lines.push(
    `attic sweep (>${result.days}d): ${verb} ${result.removed.length}, kept ${result.young.length + result.skipped.length}`
  );
  for (const e of result.removed) row(verb, e);
  for (const e of result.skipped) row('SKIPPED', e);
  for (const e of result.strays) row('STRAY', e);
  if (result.young.length) {
    lines.push(`  ${pad('(young)', 9)} ${result.young.length} entr${result.young.length === 1 ? 'y' : 'ies'} under the ${result.days}d line`);
  }
  return lines;
}

/**
 * True when the sweep has something a human should read. Drives `--quiet`.
 *
 * A zero-removal run is the normal, correct result most days — the attic fills faster
 * than it expires — and the sweep is printed inside a longer ship report, so "nothing
 * happened" is worth being able to say silently.
 */
export function worthSaying(result) {
  return result.removed.length > 0 || result.skipped.length > 0 || result.strays.length > 0 || result.backfilled.length > 0;
}

const age = (d) => (d === null || d === undefined ? '—' : `${d.toFixed(1)}d`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
