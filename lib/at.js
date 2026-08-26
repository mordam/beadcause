/**
 * A runnable copy of this repo — or any repo `root` points at — at any ref, taken away
 * afterwards. `bin/b7e-at` is the argv shell; this is the worktree itself.
 *
 * `bc-dgx7.63` names four sessions (`bc-dgx7.52`, `bc-beleq`, `bc-9ntye.3`, `bc-ogicx.5`)
 * that each needed the same thing — this tree, at some other commit, runnable — and
 * built it four different ways, two of them unsafe: one leaked three `git worktree`
 * registrations it had to clean up with `--force` by hand; one ran `git checkout` inside
 * its own live, locked worktree instead of a throwaway one; one ran the suite out of the
 * shared main checkout, which is routinely tens of commits stale. `lib/blame.js` already
 * had the answer, hardwired to `origin/main` — this lifts it out and lets it take any
 * ref. `lib/blame.js` now calls `makeAtWorktree`/`removeAtWorktree` below instead of
 * building its own.
 *
 * ## The worktree
 *
 * `git worktree add --detach` — never `EnterWorktree`, which claims a lock a sibling
 * session could trip over for a tree nobody is here to edit — under `atTreeRoot()`,
 * never `.claude/worktrees/`: a claimable worktree there is exactly the case `bc-dgx7.52`
 * had to clean up by hand, because `git worktree list` in a sibling session would show it
 * as available. `node_modules` is symlinked from `root`'s own, the same never-copy rule
 * `b7e-worktree` and `scripts/vendor.js` hold elsewhere; `public/vendor` is linked the
 * same way, by running the new tree's own `scripts/vendor.js` (best-effort — a `ref` with
 * no such script, or a run that fails, still returns a usable tree for anything that
 * only needs `node_modules`).
 *
 * ## The registry, for the one case a `finally` cannot cover
 *
 * A tree's own `meta.json` sidecar lives inside its scratch directory, so `removeAtWorktree`
 * deleting that directory is also what takes it off `--list`/`--reap` — no separate write
 * to keep in sync. `liveTrees` reads every sidecar still under `atTreeRoot()`, which is
 * exactly what survives a process that never reached its own `finally`: killed, or crashed
 * before the `try`. That is the case `bc-dgx7.52`'s own cleanup (`git worktree list | grep
 * ..., git worktree remove --force` three times, `git worktree prune`) exists to answer by
 * hand; `--list`/`--reap` are the same answer, run once, against every tree this command
 * has ever left on this Mac, not just the caller's own repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Every tree lives under here — one scratch directory per call, never `.claude/worktrees/`. */
export function atTreeRoot() {
  return path.join(os.tmpdir(), 'beadcause-at');
}

/**
 * `git worktree add --detach` at `ref`, under a fresh scratch directory, with
 * `node_modules` symlinked from `root`'s own and, unless `{ vendor: false }`,
 * `public/vendor` linked by running the new tree's own `scripts/vendor.js`.
 *
 * `root` must be a checkout of the repo `ref` belongs to (any worktree of it will do —
 * `git worktree` commands work from any of a repo's worktrees, they share one `.git`).
 *
 * Returns `{ dir, scratchRoot, sha }` — `dir` is the worktree itself, `scratchRoot` is
 * its parent (what `removeAtWorktree` deletes), `sha` is what `ref` resolved to.
 */
export function makeAtWorktree(root, ref, { vendor = true } = {}) {
  const base = atTreeRoot();
  fs.mkdirSync(base, { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(fs.realpathSync(base), 'tree-'));
  const dir = path.join(scratchRoot, 'work');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '-q', dir, ref], { cwd: root, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();

    const nmSource = path.join(root, 'node_modules');
    const nmDest = path.join(dir, 'node_modules');
    // node_modules is gitignored in this repo (and, by the same convention, in any repo
    // this is pointed at), so a fresh checkout never has one — but never clobber the rare
    // case where it does: leaving a real directory alone is the same rule `b7e-worktree`
    // holds for a worktree that already installed its own.
    if (fs.existsSync(nmSource) && !fs.existsSync(nmDest)) {
      fs.symlinkSync(fs.realpathSync(nmSource), nmDest);
    }

    let vendored = false;
    if (vendor) {
      const vendorScript = path.join(dir, 'scripts', 'vendor.js');
      if (fs.existsSync(vendorScript)) {
        try {
          execFileSync(process.execPath, [vendorScript], { cwd: dir, stdio: 'pipe' });
          vendored = true;
        } catch {
          // best-effort — a caller that only needed node_modules (scripts/test.mjs's own
          // discovery) still gets a usable tree back.
        }
      }
    }

    fs.writeFileSync(
      path.join(scratchRoot, 'meta.json'),
      JSON.stringify({ root, ref, sha, dir, vendored, pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
    );

    return { dir, scratchRoot, sha };
  } catch (err) {
    // A bad ref, or anything else that goes wrong before meta.json is written, must not
    // leave an untracked scratch directory behind — `removeAtWorktree` best-effort covers
    // a worktree that half-registered, and this covers the case nothing did.
    try {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'pipe' });
    } catch {
      /* most failures here never got far enough to register a worktree at all */
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Removes a tree made by `makeAtWorktree`, best-effort and always — `git worktree remove
 * --force` (a detached worktree that only ever ran a read-only command has nothing of its
 * own to lose), then `prune` to drop the registration if `remove` could not, then the
 * scratch directory itself — which also deletes its `meta.json`, taking it off `--list` —
 * so a failed `remove` cannot leave the tree behind forever.
 */
export function removeAtWorktree(root, dir, scratchRoot) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'pipe' });
  } catch {
    /* best effort — prune and the scratch rm below are what actually guarantee cleanup */
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
  } catch {
    /* nothing more to do about a prune that itself fails */
  }
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
}

/**
 * Every tree currently under `atTreeRoot()`, whatever call or repo built it — what
 * `--list` prints and `--reap` walks. A scratch directory with no readable `meta.json`
 * (a crash mid-`makeAtWorktree`, before it was written) is reported too, with the rest of
 * its fields `null`, so `--reap` can still remove it: nothing here is left invisible for
 * want of the sidecar it never got.
 */
export function liveTrees() {
  const base = atTreeRoot();
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const scratchRoot = path.join(base, name);
    if (!fs.statSync(scratchRoot, { throwIfNoEntry: false })?.isDirectory()) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(scratchRoot, 'meta.json'), 'utf8'));
    } catch {
      /* no sidecar, or an unreadable one — still a tree to report and reap */
    }
    out.push({
      root: null,
      ref: null,
      sha: null,
      dir: path.join(scratchRoot, 'work'),
      pid: null,
      createdAt: null,
      ...meta,
      scratchRoot,
    });
  }
  return out;
}

/**
 * Tears one entry from `liveTrees()` down. Uses its recorded `root` to deregister the
 * `git worktree` properly when there is one; without it (no `meta.json` survived), falls
 * back to deleting the scratch directory directly — the git side is left to whatever
 * repo it belongs to notice on its own next `git worktree prune`, since there is no way
 * to know which repo that is.
 */
export function reapTree(entry) {
  if (entry.root) {
    removeAtWorktree(entry.root, entry.dir, entry.scratchRoot);
  } else if (entry.scratchRoot) {
    fs.rmSync(entry.scratchRoot, { recursive: true, force: true });
  }
}
