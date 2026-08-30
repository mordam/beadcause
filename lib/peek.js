/**
 * What a sibling worktree is actually adding to a file, right now — committed and
 * uncommitted together, with no `git -C` in sight for the worktree guard to refuse.
 *
 * bc-dgx7.43. Six sessions on 2026-08-1[7-9]/22/23, each handed a worktree name by a
 * claim refusal ("lib/toolbelt.js is already claimed by another session (on
 * worktree-b7e-enroll-khoe2711) ... changing lines 198-205 of their copy"), then tried
 * to see what that worktree was actually doing — no two of them the same way. One took
 * eight calls and ended up `Read`ing a sibling's `README.md` after `git -C <abs path>`
 * was refused outright. One ran `git diff main...<branch>` against a sibling that had
 * not committed anything yet and got nothing back — silently wrong, because that is
 * exactly the state a live sibling mid-edit is in. Two more each drove `git log
 * --oneline` plus a `git diff main <branch> -- <file>` by hand, and a fifth read commit
 * logs alone with no diff at all, unable to say what the lines actually said.
 *
 * `lib/siblings.js` (bc-bmry.11) answers a related but different question — which
 * worktrees are on *any* of these files, at all — and answers it with line *ranges*
 * (`lib/regions.js`'s `--unified=0` reading), the right shape for "are we colliding".
 * This module is for the moment after that: one worktree already named, and the actual
 * *hunks* wanted, not just where they are. So the diffs here keep git's ordinary
 * context (`CONTEXT` below) rather than collapsing it to zero, and nothing here is
 * capped the way `lib/regions.js`'s `render` is — a peek is read once, by hand, not
 * folded into a refusal message six-holders wide.
 *
 * ## Resolving a name
 *
 * A worktree is asked for under any of three spellings — `worktree-b7e-gated-dgx739`
 * (the branch, and what a claim notice and `git worktree list` both print), bare
 * `b7e-gated-dgx739` (what a person actually types), or the directory itself under
 * `.claude/worktrees/`, which today is the bare form again but is matched on its own so
 * a rename of that convention does not silently break this. `resolveWorktree` tries a
 * live or retired entry in `git worktree list --porcelain` first, and only then falls
 * back to a bare `refs/heads/<branch>` lookup — the pruned case, where `rm -rf` took the
 * checkout but not the branch, which every worktree of a repo shares one object store
 * with. See lib/tidy.js's `parseWorktrees`, the same parser lib/siblings.js and
 * lib/attic.js already share.
 *
 * ## Committed, uncommitted, or both
 *
 * `git diff` between the merge-base and the working tree already reads both halves at
 * once for a live worktree — that is `combinedDiff` below, and it is the one number this
 * module actually prints. `committed`/`uncommitted` on the result are a second, cheaper
 * pair of reads (`base..HEAD` and `HEAD..worktree`) used only to *label* what kind of
 * change it is; nothing about the diff text itself depends on them. A brand new
 * untracked file needs a third path, `git diff --no-index`, because `git diff` — however
 * it is asked — never shows a file nobody has `git add`ed; see `untrackedDiff` and the
 * matching note in lib/regions.js's `changedSince`.
 *
 * ## Merge-base, not `main`'s tip
 *
 * Same reasoning as `lib/siblings.js`: `main` moves constantly on this repo (see this
 * repo's own memory, `beadcause-main-moves-constantly`), and a worktree cut a day ago has
 * usually fallen behind it by the time anyone asks. Diffing against `main`'s live tip
 * would read every other branch's landed work as this worktree's own. The merge-base
 * between `BASE_REF` and the worktree's branch is the one point both sides agree on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './gitref.js';
import { parseWorktrees, realPath } from './tidy.js';
import { liveSessions } from './claude.js';
import { beadInName } from './reap.js';
import * as pr from './pr.js';

const run = promisify(execFile);

/** A peek is read before or during an edit — it must not itself hang one. */
const TIMEOUT_MS = 10000;

/** Ordinary diff context — a peek is read for its content, not folded into a refusal. */
const CONTEXT = 3;

/** What "ahead" and the merge-base are taken against, throughout this file. */
export const BASE_REF = 'main';

/** git, or nothing — every read here fails open rather than throwing mid-report. */
async function read(dir, args) {
  try {
    return await git(dir, args, { timeout: TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * `git diff --no-index`, which exits `1` — not an error — the moment the two sides
 * differ. `git()` (lib/gitref.js) throws on any non-zero exit, which is right for every
 * other call in this file and wrong for exactly this one, so it is spawned directly.
 */
async function diffNoIndex(cwd, a, b) {
  try {
    const { stdout } = await run('git', ['diff', '--no-index', `--unified=${CONTEXT}`, '--', a, b], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (typeof err.code === 'number' && typeof err.stdout === 'string') return err.stdout;
    return null;
  }
}

function onDisk(p) {
  try {
    return fs.statSync(p).isFile() || fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every spelling of a worktree name that ought to resolve to the same worktree — see
 * the module doc. Order is not significant; `resolveWorktree` tries them all.
 */
function candidatesFor(name) {
  const bare = path.basename(String(name || '').trim().replace(/\/+$/, ''));
  if (!bare) return [];
  const withPrefix = bare.startsWith('worktree-') ? bare : `worktree-${bare}`;
  const withoutPrefix = bare.startsWith('worktree-') ? bare.slice('worktree-'.length) : bare;
  return [...new Set([bare, withPrefix, withoutPrefix])];
}

/**
 * Resolve `name` to the worktree it means, in this repo. Three states come back:
 *
 *   - a live worktree — `exists: true`, `path` real and on disk
 *   - a retired-but-still-registered one — same shape, `path` under the attic
 *   - a pruned one — directory is gone, `path: null`, `exists: false`, and everything
 *     below reads its branch straight out of refs instead
 *
 * `null` when nothing in this repo answers to any spelling of `name` — a bad name, not
 * a git failure, which callers turn into exit `4`.
 */
export async function resolveWorktree(dir, name) {
  const cands = candidatesFor(name);
  if (!cands.length) return null;

  const porcelain = await read(dir, ['worktree', 'list', '--porcelain']);
  const worktrees = porcelain ? parseWorktrees(porcelain) : [];
  for (const wt of worktrees) {
    if (!wt.branch) continue;
    const base = path.basename(wt.path);
    if (!cands.includes(wt.branch) && !cands.includes(base)) continue;
    return { branch: wt.branch, path: wt.path, exists: onDisk(wt.path), locked: Boolean(wt.locked) };
  }

  // Nothing registered — try the branch straight out of refs. Every worktree of this
  // repo shares one object store, so a branch tip survives `rm -rf` on its own checkout.
  for (const c of cands) {
    // eslint-disable-next-line no-await-in-loop -- a handful of candidates, sequential is fine
    const tip = await read(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c}`]);
    if (tip) return { branch: c, path: null, exists: false, locked: false };
  }
  return null;
}

/** The merge-base between `BASE_REF` and a worktree's branch, or null if there is none. */
export async function mergeBaseFor(dir, branch) {
  return (await read(dir, ['merge-base', BASE_REF, branch]))?.trim() || null;
}

/** How many commits `branch` has past `base` — "how far ahead of main" the bead asks for. */
export async function aheadCount(dir, base, branch) {
  const out = await read(dir, ['rev-list', '--count', `${base}..${branch}`]);
  const n = Number(String(out || '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Every file this worktree has touched since `base` — committed, uncommitted, or new. */
export async function touchedFiles(root, wt, base) {
  if (wt.exists) {
    const tracked = await read(wt.path, ['diff', '--name-only', base]);
    const names = new Set((tracked || '').split('\n').filter(Boolean));
    const untracked = await read(wt.path, ['ls-files', '--others', '--exclude-standard']);
    for (const f of (untracked || '').split('\n').filter(Boolean)) names.add(f);
    return [...names].sort();
  }
  const out = await read(root, ['diff', '--name-only', `${base}..${wt.branch}`]);
  return (out || '').split('\n').filter(Boolean).sort();
}

/**
 * One file's pending change in `wt` — the diff text, whether it holds committed work,
 * uncommitted work, or both, and whether the file is new. `null` when the file has no
 * change to show (also the answer for a path this worktree has never heard of).
 */
export async function peekFile(root, wt, base, file) {
  if (!wt.exists) {
    // Pruned — no working tree, so committed history on the branch is the whole story.
    const diff = await read(root, ['diff', `--unified=${CONTEXT}`, `${base}..${wt.branch}`, '--', file]);
    if (!diff || !diff.trim()) return null;
    return { file, diff, newFile: /^--- \/dev\/null$/m.test(diff), committed: true, uncommitted: false };
  }

  const trackedOut = await read(wt.path, ['ls-files', '--', file]);
  const isTracked = trackedOut !== null && Boolean(trackedOut.trim());

  if (!isTracked) {
    if (!onDisk(path.join(wt.path, file))) return null; // never heard of it, either way
    const diff = await diffNoIndex(wt.path, '/dev/null', file);
    if (!diff || !diff.trim()) return null;
    return { file, diff, newFile: true, committed: false, uncommitted: true };
  }

  const combined = await read(wt.path, ['diff', `--unified=${CONTEXT}`, base, '--', file]);
  if (!combined || !combined.trim()) return null;

  const [committedDiff, uncommittedDiff] = await Promise.all([
    read(wt.path, ['diff', base, 'HEAD', '--', file]),
    read(wt.path, ['diff', 'HEAD', '--', file]),
  ]);
  return {
    file,
    diff: combined,
    newFile: /^--- \/dev\/null$/m.test(combined),
    committed: Boolean(committedDiff && committedDiff.trim()),
    uncommitted: Boolean(uncommittedDiff && uncommittedDiff.trim()),
  };
}

/** `+N -M`, counted off the diff text itself rather than a second `git diff --stat` call. */
export function statOf(diffText) {
  let add = 0;
  let del = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return { add, del };
}

/**
 * Whether a pull request is already open on `branch` — the last line the bead asks for.
 * `null` when `gh` is not available at all (no auth, no remote), which callers read as
 * "could not say" rather than "no PR", the same fail-open rule the rest of this file
 * follows. Same call shape lib/prior.js already makes for the same reason.
 */
export async function openPRFor(dir, branch) {
  const avail = await pr.available();
  if (!avail.ok) return null;
  try {
    const rows = await pr.list(dir, { state: 'open', head: branch, limit: 5 });
    return rows.find((r) => r.branch === branch) || null;
  } catch {
    return null;
  }
}

/**
 * Which live worktree a bead is currently being worked from, by the same convention
 * `lib/siblings.js` reads bead/pid from the other direction: a session's own chosen
 * name, matched with `beadInName` (lib/reap.js). Best-effort — `null` when no live
 * session's name embeds `id`, which a caller turns into "nothing to resolve `--bead`
 * from" rather than a git failure.
 */
export function worktreeForBead(cfg, id) {
  const session = liveSessions(cfg).find((s) => s.cwd && beadInName(s.name) === id);
  return session ? realPath(session.cwd) : null;
}
