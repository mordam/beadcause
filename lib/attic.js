/**
 * The attic sweep a *human* runs — `ship` step 7b, on top of the one the daemon runs.
 *
 * `expireRetired` in lib/tidy.js is the sweep itself: every gate, and the removal. It
 * runs on the advocate's tick, unattended, and it returns exactly what a log line needs.
 * This file is the other caller — the `ship` skill — and it needs three things that a
 * fifteen-minute tick has no reason to produce:
 *
 * 1. **Strays.** An unregistered directory in the attic, or a `.note` whose directory is
 *    gone, means somebody moved things by hand. `expireRetired` walks registrations and
 *    ignores everything else, which is right for an unattended process — it must never
 *    delete what it does not understand. But a person sweeping the attic wants to be
 *    *told*, so this reports them, by name, and still never deletes them.
 * 2. **A report.** One summary line, a row per exception, and a count for the boring
 *    bulk. A ship prints this to a human who then decides whether to care.
 * 3. **`--backfill`.** Entries retired before the `.note` convention have no stamp and
 *    are therefore immortal. The daemon deliberately will not guess their age; a person
 *    with `--dry-run` in the other hand can.
 *
 * ## Why this is a layer and not a second implementation
 *
 * Because a second implementation is the entire bug this file was filed for. The sweep
 * used to be 210 lines of bash in `~/.claude-personal/skills/ship/`, versioned by
 * nothing and tested by nothing, run by every ship — and it drifted from the daemon that
 * fills the attic. bc-bcdp is what that cost: one line of it inverted its own answer,
 * reported 68 of 85 healthy entries as unregistered strays, and a session believed the
 * output and filed a bug describing a hand-`mv` that never happened. Porting it found a
 * second one nobody could have seen — `grep -rlq -- "$n" "$dir" --exclude-dir=archive`
 * puts the flag *after* the `--`, which ends option parsing, so `--exclude-dir=archive`
 * was a *filename*: it does not exist, the warning went to `/dev/null`, `archive/` was
 * searched anyway, and every *spent* handoff protected its attic entry forever. Not an
 * ugrep quirk and not about flag order — options after the path are honoured, and `--`
 * would have swallowed that flag on any grep ever written. test/grepargs.mjs measures
 * both halves of that and fails the repo if the form comes back.
 *
 * So there is one set of gates, in lib/tidy.js, under `npm test`. This file adds what a
 * human needs on top and decides nothing about what may be removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expireRetired, parseWorktrees, retiredAt, slimAttic, ATTIC_DAYS } from './tidy.js';

const run = promisify(execFile);

const RETIRED = path.join('.claude', 'worktrees-retired');

export const DEFAULT_DAYS = ATTIC_DAYS;

/** git, never through a shell, and answering with a status rather than an exception. */
async function git(cwd, args, { timeout = 20000 } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: '', err: String(err.stderr || err.message || '').trim() };
  }
}

const under = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * The main checkout of the repo containing `dir` — and it must *be* it.
 *
 * `git worktree remove` on a sibling from inside a worktree does work, but the whole
 * vocabulary here is main-checkout-relative and a worktree cwd is how you end up
 * removing the tree you are standing in. So the sweep refuses rather than adapts.
 */
async function locate(dir) {
  const own = await git(dir, ['rev-parse', '--absolute-git-dir']);
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!own.ok || !common.ok) throw new Error(`not a git repo: ${dir}`);
  const gitDir = path.resolve(own.out.trim());
  const commonDir = path.resolve(common.out.trim());
  const main = path.dirname(commonDir);
  if (gitDir !== commonDir) throw new Error(`${dir} is a worktree, not the main checkout — run this from ${main}`);
  return main;
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

/** The `.note` sidecars, by the entry name they belong to. */
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
 * Directory mtime is the only signal left, and it is a *late* proxy — it tracks the last
 * content change, never anything earlier than the retirement — so a backfilled entry can
 * only survive longer than it should, never be pruned sooner. That is the safe direction,
 * and it is still a guess, which is why the daemon never does this and it takes a flag.
 *
 * A dry run proposes without writing. The sweep that follows will therefore still report
 * those entries as stampless, which is the truth about the attic as it stands: run it
 * again without `--dry-run` to actually give them one.
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
    const stamp = mtime.toISOString().replace(/\.\d+Z$/, 'Z');
    if (!dryRun) {
      fs.writeFileSync(note, `${stamp}  retired (backfilled from directory mtime, exact date unknown)\n`, { mode: 0o644 });
    }
    done.push({ name, stamp });
  }
  return done;
}

/**
 * Sweep one repo's attic, for a person.
 *
 * The gates and the removal are `expireRetired`'s; everything here is around them. Never
 * throws for anything it *found* — only for how it was called, because a ship must not
 * fail over an attic entry it could not remove.
 */
export async function sweepAttic(dir, { days = DEFAULT_DAYS, dryRun = false, backfill = false, prMerges = true, sessions = [] } = {}) {
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
    slimmed: [],
    freedBytes: 0,
  };
  if (!fs.existsSync(retiredRoot)) return result;
  result.ran = true;

  if (backfill) result.backfilled = backfillNotes(retiredRoot, { dryRun });

  const { removed, kept } = await expireRetired(main, { days, dryRun, prMerges, sessions });
  result.removed = removed.map((e) => ({
    name: e.name,
    ageDays: e.ageDays === undefined ? null : Number(e.ageDays),
    branch: e.branch,
    why: dryRun ? `would remove (${e.branch})` : `removed (${e.branch} kept)`,
  }));
  result.skipped = kept.map((e) => ({
    name: e.name,
    ageDays: e.ageDays === undefined ? null : Number(e.ageDays),
    why: e.why,
  }));

  // The entries that are simply not old enough yet — the bulk of a healthy attic, and
  // the one outcome `expireRetired` has no reason to return, because a fifteen-minute
  // tick narrating them would bury the entry that is actually stuck. A person sweeping
  // by hand wants the count, or a run that removed nothing looks like a run that failed.
  const cutoff = Date.now() - days * 86400000;
  const swept = new Set([...result.removed, ...result.skipped].map((e) => e.name));

  // One listing, walked once — and taken *after* the removals, because a removal retires
  // a registration and a listing captured beforehand would call every entry it just took
  // a stray. (Reading it back through `grep -q` in a pipeline is what produced bc-bcdp's
  // false bug report; here it is a Set of resolved paths and cannot invert.)
  const registered = new Set(
    parseWorktrees((await git(main, ['worktree', 'list', '--porcelain'])).out).map((w) => path.resolve(w.path))
  );

  for (const name of atticDirs(retiredRoot)) {
    const here = path.resolve(path.join(retiredRoot, name));
    if (!registered.has(here)) {
      result.strays.push({ name, ageDays: null, why: 'not a registered worktree — inspect by hand' });
      continue;
    }
    if (swept.has(name)) continue;
    const at = retiredAt(path.join(retiredRoot, `${name}.note`));
    if (at !== null && at > cutoff) result.young.push({ name, ageDays: (Date.now() - at) / 86400000, why: `younger than ${days}d` });
  }
  for (const name of atticNotes(retiredRoot)) {
    if (!fs.existsSync(path.join(retiredRoot, name))) {
      result.strays.push({ name: `${name}.note`, ageDays: null, why: 'orphan .note, directory already gone' });
    }
  }

  // `expireRetired` walks registrations, so an entry under `worktrees-retired/` that is
  // not one has never been considered by it — which is exactly what makes it a stray.
  result.strays.sort((a, b) => a.name.localeCompare(b.name));

  // An attic bounded by age is not bounded by size: four entries with a real
  // `node_modules` were half of the 1.2 GB this sweep was written for, and none of them
  // was old enough to remove. `slimAttic` owns that gate too — this layer only reports
  // it — and it runs *after* the expiry so it never weighs a tree that has just gone.
  const slim = await slimAttic(main, { dryRun, sessions });
  result.slimmed = slim.slimmed.map((e) => ({
    name: e.name,
    bytes: e.bytes,
    why: `${dryRun ? 'would drop' : 'dropped'} ${e.dropped.join(', ')} (${mb(e.bytes)})`,
  }));
  result.freedBytes = slim.bytes;
  for (const k of slim.kept) result.skipped.push({ name: k.name, ageDays: null, why: `build output kept — ${k.why}` });

  return result;
}

/**
 * The report: one line plus a row per exception, because the common case is boring.
 */
export function describeAttic(result) {
  const lines = [];
  const row = (verb, e) => lines.push(`  ${pad(verb, 9)} ${pad(e.name, 34)} ${lpad(age(e.ageDays), 5)}  ${e.why}`);

  for (const b of result.backfilled) lines.push(`  backfilled  ${b.name}  ${b.stamp}`);
  if (result.backfill) {
    lines.push(`${result.dryRun ? 'would backfill' : 'backfilled'} ${result.backfilled.length} note(s)`);
  }

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
  for (const e of result.slimmed) row('slimmed', { ...e, ageDays: null });
  if (result.slimmed.length) {
    lines.push(`  ${pad('', 9)} ${result.dryRun ? 'would free' : 'freed'} ${mb(result.freedBytes)} of regenerable build output`);
  }
  if (result.young.length) {
    lines.push(
      `  ${pad('(young)', 9)} ${result.young.length} entr${result.young.length === 1 ? 'y' : 'ies'} under the ${result.days}d line`
    );
  }
  return lines;
}

/**
 * True when the sweep has something a human should read. Drives `--quiet`.
 *
 * A zero-removal run is the normal, correct result most days — the attic fills faster
 * than it expires — and this report is printed inside a longer one, so "nothing
 * happened" is worth being able to say silently.
 */
export function worthSaying(result) {
  return (
    result.removed.length > 0 ||
    result.skipped.length > 0 ||
    result.strays.length > 0 ||
    result.backfilled.length > 0 ||
    result.slimmed.length > 0
  );
}

const age = (d) => (d === null || d === undefined || Number.isNaN(d) ? '—' : `${d.toFixed(1)}d`);
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
