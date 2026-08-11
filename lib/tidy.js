/**
 * Clearing up after a session that has ended.
 *
 * An advocate opens a real Claude session per bead, and a session that obeys its
 * repo's rules creates a git worktree before its first edit. Two beads a day is
 * seven hundred worktrees a year. The window closes itself now (see `launch` in
 * lib/session.js), and the exit marker is removed with the worker — the worktree was
 * the one leftover with nobody to clear it.
 *
 * The rule is deliberately narrow, because this is the only part of beadcause that
 * removes anything a human might want back. A worktree is retired only when **all
 * five** hold:
 *
 * 1. it lives under `<main checkout>/.claude/worktrees/` — never the main checkout,
 *    never `worktrees-retired/`, never anything outside;
 * 2. it is not locked — a lock is a session's claim on it, and claims are honoured;
 * 3. no live `claude` process is sitting in it;
 * 4. `git status --porcelain` is empty, untracked files included;
 * 5. its branch is an ancestor of `main` — everything it did is already in main.
 *
 * Anything failing one of those is **left alone and named**, with the reason. A
 * sweep that silently skipped things would be indistinguishable from a sweep that
 * silently deleted the wrong ones, and only one of those is recoverable.
 *
 * And "retired" means moved, not deleted: `git worktree move` into
 * `.claude/worktrees-retired/`, which is the same soft delete the `ship` skill does
 * by hand. The branch is kept — `git branch -d` refuses a branch checked out in
 * another worktree, and keeping it is what makes a retired worktree resumable,
 * which is the entire difference between this and `rm -rf`.
 *
 * A soft delete nothing ever hardens is a rename, though, and for a while that is
 * all this was: `.claude/worktrees-retired/` reached a hundred entries and 1.2 GB on
 * this repo in two days, because retiring ran every fifteen minutes unattended and
 * the only thing that ever emptied the attic was a shell script a human ran at ship
 * time. `expireRetired` below is the other half — the same gates, plus an age, run on
 * the same tick — and it is what makes "retired" eventually mean gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pr from './pr.js';

const run = promisify(execFile);

const WORKTREES = path.join('.claude', 'worktrees');
const RETIRED = path.join('.claude', 'worktrees-retired');

/**
 * A worktree nobody has touched for this long is safe to move.
 *
 * The other four conditions all assume that "in use" is something git or the process
 * table can see, and there is one case where it isn't: an agent editing a worktree
 * **by absolute path** from a session whose own cwd is somewhere else entirely. Its
 * session record points at another directory, so the liveness check misses it, and
 * if the branch happens to be merged and clean at that instant the worktree is moved
 * out from under it mid-edit. That is not hypothetical — it happened to this file's
 * own author, twenty minutes after the sweep first shipped.
 *
 * So: recent modification counts as occupancy. Cheap, and wrong only in the
 * direction of leaving something alone for another ten minutes.
 */
const QUIET_MINUTES = 10;

/** Newest mtime anywhere in the worktree, skipping .git and node_modules. */
function lastTouched(dir, depth = 0) {
  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.venv') continue;
    const p = path.join(dir, e.name);
    try {
      const st = fs.statSync(p);
      newest = Math.max(newest, st.mtimeMs);
      // Deep enough to catch an edit to lib/foo.js or public/bar.css without
      // walking a whole dependency tree.
      if (e.isDirectory() && depth < 2) newest = Math.max(newest, lastTouched(p, depth + 1));
    } catch {
      /* vanished mid-walk */
    }
  }
  return newest;
}

/** git, never through a shell, and never fatal: a sweep must not take the daemon down. */
async function git(cwd, args, { timeout = 20000 } = {}) {
  const { stdout } = await run('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * The main checkout of the repo containing `dir`.
 *
 * `--git-common-dir` is the one that answers this: inside a worktree it points at
 * the *parent* repo's `.git`, which is exactly the distinction that matters here,
 * since a sweep run from a worktree must still operate on the repo as a whole.
 */
async function mainCheckout(dir) {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return path.dirname(common);
}

/** `git worktree list --porcelain` → one record per worktree, in list order. */
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), branch: null, locked: false, detached: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  return out;
}

const under = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * `path.resolve`, but through symlinks — and the difference decides whether a worktree
 * somebody is sitting in gets moved out from under them.
 *
 * git reports worktree paths fully resolved. A session's `cwd` is whatever the process
 * was started in, which on macOS routinely keeps a symlinked prefix: `/var/folders/…`
 * and `/private/var/folders/…` are the same directory and share not one character of
 * their first eight. Compared with `path.resolve` alone the occupancy check silently
 * answers "nobody is in it" for every one of them.
 *
 * Falls back to the plain resolve for a path that no longer exists, which is the normal
 * end of a session whose directory has already gone.
 */
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Is `branch` already contained in main — and which main answered?
 *
 * `main` alone is the wrong ref to ask, and on a busy repo it is wrong about most
 * of the attic. Nothing merges locally any more: a worker opens a pull request and
 * GitHub merges it, so `origin/main` moves and the local `main` branch stays exactly
 * where it was the last time somebody pulled. On this checkout that gap was **fifty
 * commits**, and eight retired worktrees were being described as "not merged into
 * main" while their work had been on origin/main for two days.
 *
 * So ask `origin/main` first, and fall back to `main` for a repo with no remote.
 * Both are only consulted when they exist — `rev-parse --verify` is the cheap way to
 * find out, and a repo that has never fetched simply answers on the local ref.
 *
 * Returns the ref that contained it (useful in a note), or null for neither.
 */
async function containedInMain(main, branch) {
  for (const ref of ['origin/main', 'main']) {
    const exists = await git(main, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
      () => true,
      () => false
    );
    if (!exists) continue;
    const yes = await git(main, ['merge-base', '--is-ancestor', branch, ref]).then(
      () => true,
      () => false
    );
    if (yes) return ref;
  }
  return null;
}

/**
 * Sweep one repo. Returns what was retired and what was left, with reasons for both.
 *
 * `sessions` is the live-`claude` list from lib/claude.js — the check that stops a
 * worktree being moved out from under someone who is working in it. It is passed in
 * rather than read here so the whole tick is decided against one snapshot of what
 * was running.
 */
export async function sweepWorktrees(dir, { sessions = [], dryRun = false, prMerges = false } = {}) {
  const main = await mainCheckout(dir);
  const wtRoot = path.join(main, WORKTREES);
  const retiredRoot = path.join(main, RETIRED);

  // Drops registrations whose directory is already gone, so they don't show up as
  // mysteriously unsweepable rows forever.
  await git(main, ['worktree', 'prune']).catch(() => {});

  const list = parseWorktrees(await git(main, ['worktree', 'list', '--porcelain']));
  const retired = [];
  const left = [];

  for (const wt of list) {
    const name = path.basename(wt.path);
    // The main checkout is always the first row, and it passes several of the
    // conditions below — it is excluded by location, not by luck.
    if (path.resolve(wt.path) === path.resolve(main)) continue;
    if (!under(path.resolve(wt.path), path.resolve(wtRoot))) continue; // retired, or outside — not ours
    if (wt.locked) {
      left.push({ name, why: 'locked' });
      continue;
    }
    if (wt.detached || !wt.branch) {
      left.push({ name, why: 'detached HEAD — no branch to check against main' });
      continue;
    }
    const inIt = sessions.find((s) => s.cwd && under(real(s.cwd), real(wt.path)));
    if (inIt) {
      left.push({ name, why: `a session is working in it (pid ${inIt.pid})` });
      continue;
    }

    const touchedMinsAgo = (Date.now() - lastTouched(wt.path)) / 60000;
    if (touchedMinsAgo < QUIET_MINUTES) {
      left.push({ name, why: `touched ${Math.max(1, Math.round(touchedMinsAgo))} minute(s) ago` });
      continue;
    }

    // Set when GitHub, not git, is what said this branch is safely gone. It ends up
    // in the retirement note, because "retired after #42" and "retired after abc1234"
    // are different stories and only one of them is findable later.
    let mergedVia = '';

    let dirty;
    try {
      dirty = (await git(wt.path, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
    } catch (err) {
      left.push({ name, why: `cannot read its status — ${err.message.split('\n')[0]}` });
      continue;
    }
    if (dirty) {
      left.push({ name, why: `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` });
      continue;
    }

    // Contained in main, so nothing it did is only here — see `containedInMain` for
    // why that question is asked of origin/main before the local branch.
    let merged = (await containedInMain(main, wt.branch)) !== null;

    /**
     * The second way a branch can be safely gone, and now the usual one.
     *
     * A squash-merged pull request puts a *new* commit on main with the branch's
     * tree and none of its history, so the branch never becomes an ancestor of
     * anything — the test above is false forever, and every delivered worktree
     * would pile up unswept while the log said "not merged into main" about work
     * that shipped last week.
     *
     * GitHub is the authority on whether it merged, so ask it. Only when the cheap
     * local test has already said no, and only for a branch that actually has a
     * pull request: an unremoted repo, a missing `gh`, or a branch nobody ever
     * pushed all answer null here, which leaves the old behaviour exactly as it was.
     */
    if (!merged && prMerges) {
      const request = await pr.viewForBranch(wt.path, wt.branch);
      if (request?.state === 'MERGED') {
        merged = true;
        mergedVia = `#${request.number}`;
      }
    }
    if (!merged) {
      left.push({ name, why: prMerges ? 'not merged into main, and its PR is not merged either' : 'not merged into main' });
      continue;
    }

    if (dryRun) {
      retired.push({ name, branch: wt.branch, dryRun: true });
      continue;
    }

    try {
      fs.mkdirSync(retiredRoot, { recursive: true });
      // A name collision would mean overwriting an older retirement, which is the
      // one irreversible thing in this file. Suffix instead.
      let dest = path.join(retiredRoot, name);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(retiredRoot, `${name}-${n}`);
      await git(main, ['worktree', 'move', wt.path, dest]);
      // The same stamp `ship` leaves by hand, so a retired worktree says when and
      // against what — otherwise the directory is just a name with no story.
      const head = (await git(main, ['rev-parse', '--short', wt.branch]).catch(() => '')).trim();
      fs.writeFileSync(`${dest}.note`, `${new Date().toISOString()}  retired by beadcause after ${mergedVia || head || 'merge'}\n`, {
        mode: 0o644,
      });
      retired.push({ name, branch: wt.branch, to: dest });
    } catch (err) {
      left.push({ name, why: `could not retire it — ${err.message.split('\n')[0]}` });
    }
  }

  return { retired, left, retiredRoot };
}

/* ------------------------------------------------------------------ the attic */

/**
 * How long a retired worktree stays resumable before it may be removed for good.
 *
 * Two days is the same number the `ship` skill's prune-retired.sh uses, and it is a
 * guess about people rather than about git: a session you might still go back to is
 * one you remember, and nobody remembers a worktree from the day before yesterday.
 */
const ATTIC_DAYS = 2;

/**
 * When a retired worktree was retired, from its `.note` sidecar, or null.
 *
 * Two writers fill this attic and they disagree on precision — `ship` shells out to
 * `date -u +%FT%TZ` and writes whole seconds, `sweepWorktrees` above writes
 * `toISOString()` milliseconds — but both put an ISO-8601 UTC stamp first on line
 * one, and `Date.parse` takes either. No note means no answer: the entry predates
 * the convention, and guessing its age from a directory mtime is how you delete
 * something because a background process touched it.
 */
function retiredAt(note) {
  let first;
  try {
    first = fs.readFileSync(note, 'utf8').split('\n', 1)[0];
  } catch {
    return null;
  }
  const at = Date.parse((first.trim().split(/\s+/)[0] || '').trim());
  return Number.isFinite(at) ? at : null;
}

/** Does a live handoff still name this worktree? Then somebody means to resume it. */
function namedByHandoff(main, name) {
  const dir = path.join(main, '.claude', 'handoffs');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    // `archive/` is where a handoff goes once it has been picked up; a name in there
    // is a record of a finished thread, not a claim on the directory.
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    try {
      if (fs.readFileSync(path.join(dir, e.name), 'utf8').includes(name)) return true;
    } catch {
      /* unreadable — not a claim */
    }
  }
  return false;
}

/**
 * Empty the soft-delete attic of entries that have outlived their resumability.
 *
 * `sweepWorktrees` above is the first half of the story and, until this existed, the
 * only half: it *moves* finished worktrees into `.claude/worktrees-retired/` and
 * nothing ever moved them out. On this repo that attic reached a hundred entries and
 * 1.2 GB in two days, because the only thing that ever swept it was a shell script in
 * the `ship` skill — which runs when a human ships, and the daemon retiring worktrees
 * every fifteen minutes is not a human shipping. The half that fills ran unattended;
 * the half that empties did not. This is that half.
 *
 * The gates are `sweepWorktrees`' five, plus age, plus one more — and they are the
 * same gates on purpose, because this is the step where a directory stops existing:
 *
 * - **old enough**, from the `.note` stamp; no note means keep it and say so;
 * - **unlocked** — a lock is a live session's claim, and claims are honoured;
 * - **on a branch** — a detached HEAD has no ref to check containment against;
 * - **nobody in it** — a session cwd inside it outranks every other signal;
 * - **no tracked modifications** — untracked and ignored files are *expected* here
 *   (carrying them along is the whole point of a soft delete), tracked edits are not;
 * - **contained in main**, or merged as a pull request GitHub says merged;
 * - **not named by a live handoff** — that is somebody saying they will be back.
 *
 * Removal is `git worktree remove`, never `rm -rf`: every entry is still a registered
 * worktree, and an rm leaves a dangling registration behind. The branch is kept — the
 * directory was a checkout, the ref is the only human-readable label left on those
 * commits, and it costs nothing.
 *
 * Unregistered directories in the attic are ignored entirely, not removed: this walks
 * registrations, and a stray directory means somebody moved things by hand, which is
 * a thing to look at rather than a thing to delete.
 */
export async function expireRetired(dir, { sessions = [], days = ATTIC_DAYS, dryRun = false, prMerges = false } = {}) {
  const main = await mainCheckout(dir);
  const retiredRoot = path.join(main, RETIRED);
  const removed = [];
  const kept = [];
  if (!(days > 0) || !fs.existsSync(retiredRoot)) return { removed, kept, retiredRoot };

  const cutoff = Date.now() - days * 86400000;
  const list = parseWorktrees(await git(main, ['worktree', 'list', '--porcelain']));

  for (const wt of list) {
    const here = path.resolve(wt.path);
    if (!under(here, path.resolve(retiredRoot))) continue;
    const name = path.basename(here);
    const note = path.join(retiredRoot, `${name}.note`);

    const at = retiredAt(note);
    if (at === null) {
      kept.push({ name, why: 'no .note — nothing says how old it is' });
      continue;
    }
    // Still inside the window. The bulk of a healthy attic is this, and it is the
    // one outcome not worth a row: a sweep that narrated every young entry every
    // fifteen minutes would bury the one that is stuck.
    if (at > cutoff) continue;

    const ageDays = ((Date.now() - at) / 86400000).toFixed(1);
    const row = (why) => kept.push({ name, ageDays, why });

    if (wt.locked) {
      row('locked — a live session is in it');
      continue;
    }
    if (wt.detached || !wt.branch) {
      row('detached HEAD — no branch to check against main');
      continue;
    }
    const inIt = sessions.find((s) => s.cwd && under(real(s.cwd), real(here)));
    if (inIt) {
      row(`a session is working in it (pid ${inIt.pid})`);
      continue;
    }

    let dirty;
    try {
      // `--untracked-files=no`, unlike the retirement sweep above: a retired worktree
      // is *expected* to carry untracked and ignored files, and demanding it be clean
      // of them would gate the whole attic on a stray .DS_Store.
      dirty = (await git(here, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).length;
    } catch (err) {
      row(`cannot read its status — ${err.message.split('\n')[0]}`);
      continue;
    }
    if (dirty) {
      row(`${dirty} uncommitted tracked file${dirty === 1 ? '' : 's'}`);
      continue;
    }

    let merged = (await containedInMain(main, wt.branch)) !== null;
    // The squash-merge case, exactly as in the retirement sweep: a squashed branch is
    // never an ancestor of anything, so without this every delivered worktree sits in
    // the attic forever being described as unmerged work.
    if (!merged && prMerges) {
      const request = await pr.viewForBranch(main, wt.branch);
      if (request?.state === 'MERGED') merged = true;
    }
    if (!merged) {
      row('not merged into main — removing it destroys its only copy');
      continue;
    }

    if (namedByHandoff(main, name)) {
      row('named by a live handoff');
      continue;
    }

    if (dryRun) {
      removed.push({ name, branch: wt.branch, ageDays, dryRun: true });
      continue;
    }

    try {
      // `--force`, and it is doing exactly one job: `git worktree remove` refuses a
      // worktree carrying *untracked* files, and a retired worktree is allowed to carry
      // them — that is what the soft delete is for. Without this the sweep passes every
      // gate above and then loses to git on the last line, forever: two of the 105
      // entries in the attic that filed this bug were in that state, and no amount of
      // waiting would have changed it. (Ignored files are fine unforced; git only
      // objects to untracked ones. It is a minority of entries and a permanent one.)
      //
      // What it is *not* doing is overriding a gate. A single `--force` covers the
      // unclean case only; a locked worktree needs two, and the lock check above means
      // this never reaches one. Tracked modifications and unmerged commits were both
      // refused several lines earlier, on their own evidence, and neither is something
      // git would have caught here anyway.
      await git(main, ['worktree', 'remove', '--force', here]);
      fs.rmSync(note, { force: true });
      removed.push({ name, branch: wt.branch, ageDays });
    } catch (err) {
      row(`git worktree remove refused — ${err.message.split('\n')[0]}`);
    }
  }

  return { removed, kept, retiredRoot };
}

/** One line for a log or a card: what the attic gave up, and what is stuck in it. */
export function describeExpiry({ removed, kept }) {
  const parts = [];
  if (removed.length) parts.push(`expired ${removed.map((r) => r.name).join(', ')}`);
  if (kept.length) parts.push(`attic stuck on ${kept.map((k) => `${k.name} (${k.why})`).join(', ')}`);
  return parts.join(' · ');
}

/** One line for a log or a card: what went, and what stayed and why. */
export function describeSweep({ retired, left }) {
  const parts = [];
  if (retired.length) parts.push(`retired ${retired.map((r) => r.name).join(', ')}`);
  // Only the blocked ones are worth a card's width; "locked" is the normal state of
  // every worktree somebody is actually using, and listing them all would bury the
  // one that has uncommitted work in it.
  const notable = left.filter((l) => !/^locked$/.test(l.why));
  if (notable.length) parts.push(`left ${notable.map((l) => `${l.name} (${l.why})`).join(', ')}`);
  return parts.join(' · ');
}
