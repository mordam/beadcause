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
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WORKTREES = path.join('.claude', 'worktrees');
const RETIRED = path.join('.claude', 'worktrees-retired');

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
 * Sweep one repo. Returns what was retired and what was left, with reasons for both.
 *
 * `sessions` is the live-`claude` list from lib/claude.js — the check that stops a
 * worktree being moved out from under someone who is working in it. It is passed in
 * rather than read here so the whole tick is decided against one snapshot of what
 * was running.
 */
export async function sweepWorktrees(dir, { sessions = [], dryRun = false } = {}) {
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
    const inIt = sessions.find((s) => s.cwd && under(path.resolve(s.cwd), path.resolve(wt.path)));
    if (inIt) {
      left.push({ name, why: `a session is working in it (pid ${inIt.pid})` });
      continue;
    }

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

    // Ancestor of main, so nothing it did is only here. `--is-ancestor` exits 1 for
    // "no", which execFile reports as an error rather than a status.
    const merged = await git(main, ['merge-base', '--is-ancestor', wt.branch, 'main']).then(
      () => true,
      () => false
    );
    if (!merged) {
      left.push({ name, why: 'not merged into main' });
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
      retired.push({ name, branch: wt.branch, to: dest });
    } catch (err) {
      left.push({ name, why: `could not retire it — ${err.message.split('\n')[0]}` });
    }
  }

  return { retired, left, retiredRoot };
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
