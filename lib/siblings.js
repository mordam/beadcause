/**
 * Which live worktrees are already changing the files a bead is about to touch — asked
 * before the first `Edit`, not answered by one.
 *
 * bc-bmry.11. Four sessions on 2026-08-18 each worked out what their siblings were doing
 * against `lib/server.js` by a different hand-rolled survey: six `git` calls before
 * cutting its own worktree, a shorter version that learned about the collision only from
 * the Edit tool's refusal, a loop with branch names typed in by hand, and one that paid
 * for not looking first and had to rename its own module mid-session. The full account is
 * on the bead.
 *
 * The claim notice (`scripts/claim-guard.sh`, lib/claims.js, lib/regions.js) already
 * computes almost everything this needs — *which file*, *who is on it*, *which lines* —
 * and is good at it. It fires too late to help a session choosing a module name or
 * deciding whether to `EnterWorktree` at all: by the first `Edit`, the design is already
 * made. This module answers the same question earlier, from the one thing available
 * before any edit exists — `git worktree list` and the branches it names — rather than
 * from the claim register, which is in-memory in the daemon and empty until an edit has
 * actually been attempted.
 *
 * ## Two ways to read a worktree's changes, and why both exist
 *
 * `changedSince` (lib/regions.js) diffs a worktree's actual working tree against a base
 * commit — committed and uncommitted changes together, which is right for a worktree that
 * is still on disk. `changedBetween` diffs two refs instead, paying nothing for a working
 * tree at all, which is the only thing that can answer for a worktree whose directory was
 * `rm -rf`'d without `git worktree remove` — its branch survives in the shared object
 * store even though `changedSince` would find nowhere to run `git diff`. Every row below
 * picks whichever of the two its worktree can actually answer; see `state` on the row for
 * which one it got.
 *
 * ## Bead and pid come from `liveSessions`, not from the claim register
 *
 * `lib/claims.js` knows *files*, not *beads* — nothing in it names who is on a worktree,
 * only who is on a path. `lib/claude.js`'s `liveSessions` is `~/.claude/sessions/*.json`,
 * matched here by `cwd`, and `beadInName` (lib/reap.js) reads the bead id off a session's
 * own chosen name — the same convention the reap sweep already trusts. Best-effort, same
 * as both of those: a worktree with no matching live session still gets a row, with no
 * bead and no pid, because the git evidence (branch, commits, lines) does not depend on
 * anyone still being logged in to have written it.
 */
import fs from 'node:fs';
import { git, mainCheckout } from './gitref.js';
import { parseWorktrees, realPath } from './tidy.js';
import { changedSince, changedBetween, render } from './regions.js';
import { liveSessions } from './claude.js';
import { beadInName } from './reap.js';

/** A survey is read before an edit, not instead of one — it must not itself hang one. */
const TIMEOUT_MS = 5000;

/** More than this and the list is the story, not any one commit in it. */
const MAX_COMMITS = 5;

/** What "ahead" means throughout this file — see the module doc on why it is not `HEAD`. */
export const BASE_REF = 'main';

/** git, or nothing — a survey must fail open, the same contract lib/regions.js keeps. */
async function read(dir, args) {
  try {
    return await git(dir, args, { timeout: TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** Is this worktree's directory still on disk? A registration can outlive its tree. */
function onDisk(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Commits `branch` has, ahead of `base`, that touch at least one of `files` — capped.
 *
 * `git log base..branch -- files...` rather than a plain commit count: a branch can be
 * fifty commits ahead of `main` with none of them near the file this is asking about, and
 * a count that did not filter by path would say "fifty" about a branch that is not really
 * in the way at all.
 */
async function commitsTouching(dir, base, branch, files) {
  const out = await read(dir, ['log', '--oneline', `${base}..${branch}`, '--', ...files]);
  if (out === null) return { commits: [], overflow: 0 };
  const lines = out.split('\n').filter(Boolean);
  const commits = lines.slice(0, MAX_COMMITS).map((line) => {
    const sp = line.indexOf(' ');
    return sp === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
  });
  return { commits, overflow: Math.max(0, lines.length - MAX_COMMITS) };
}

/**
 * Every live worktree whose branch has changed at least one of `files`, since `BASE_REF`.
 *
 * `dir` is where this runs `git` from — any worktree of the repo answers identically for
 * `worktree list`, so it need not be the main checkout, only somewhere real. It is also
 * `self`: the worktree a caller is asking from is never reported as its own sibling, and
 * neither is the main checkout, which this repo's own convention holds should never carry
 * an edit in the first place.
 *
 * Returns `[]` for no files, for a `dir` that is not a git checkout, and for a repo with
 * no colliding worktree — the empty answer is one shape, not three, because a caller
 * checking "does anything hold this" wants a boolean, and every one of those is "no".
 */
export async function siblingsFor(dir, files, { cfg = {} } = {}) {
  const clean = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
  if (!clean.length) return [];

  const porcelain = await read(dir, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return [];

  const self = realPath(dir);
  const main = await mainCheckout(dir).catch(() => null);
  const worktrees = parseWorktrees(porcelain);
  const sessions = liveSessions(cfg);

  const rows = [];
  for (const wt of worktrees) {
    if (!wt.branch || wt.detached) continue;
    const wtReal = realPath(wt.path);
    if (wtReal === self) continue;
    if (main && wtReal === realPath(main)) continue;

    const exists = onDisk(wt.path);
    // The merge-base with `wt.branch`, not `BASE_REF` itself — `main` has almost always
    // moved past the point this branch was cut from, by other branches merging in, and a
    // diff taken against its current tip would read every one of *their* changes as this
    // worktree's own. The merge-base is the one point both sides agree on, which is the
    // same reason lib/regions.js never diffs against a literal ref either.
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const base = (await read(dir, ['merge-base', BASE_REF, wt.branch]))?.trim();
    if (!base) continue; // no history in common with BASE_REF — nothing this can honestly say

    const hits = [];
    for (const file of clean) {
      // eslint-disable-next-line no-await-in-loop -- one worktree's files, sequential is fine
      const spans = exists ? await changedSince(wt.path, file, base) : await changedBetween(dir, base, wt.branch, file);
      if (spans && spans.now && spans.now.length) hits.push({ file, ranges: render(spans.now) });
    }
    if (!hits.length) continue;

    // eslint-disable-next-line no-await-in-loop -- likewise, one worktree at a time
    const { commits, overflow } = await commitsTouching(dir, base, wt.branch, clean);
    const session = sessions.find((s) => s.cwd && realPath(s.cwd) === wtReal) || null;

    rows.push({
      branch: wt.branch,
      path: wt.path,
      state: exists ? 'live' : 'pruned',
      locked: Boolean(wt.locked),
      lockLive: Boolean(wt.locked && session),
      bead: session ? beadInName(session.name) : null,
      session: session ? { pid: session.pid, name: session.name, status: session.status } : null,
      files: hits,
      commits,
      commitsOverflow: overflow,
    });
  }
  return rows;
}
