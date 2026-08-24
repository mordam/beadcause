/**
 * Will this branch and a sibling editing the same file actually merge — and does the
 * result still pass? `bin/b7e-premerge` is the argv shell; this is the simulation.
 *
 * bc-dgx7.52: a session audit found three sessions on 2026-08-24 hitting the same
 * collision — a sibling worktree with uncommitted or committed changes to a file they
 * were about to deliver — and each resolving it a different way. `bc-3rjan` did the
 * whole thing by hand: `git merge-tree --write-tree HEAD <branch>`, `git show
 * <tree>:<file>` to read the conflict markers out, `sed`/a python heredoc to resolve
 * them, then copied the result over its *own working copy* to run the suite — eleven
 * calls, and a failure part-way through would have left the branch it was about to
 * deliver holding the sibling's code. `bc-dgx7.37` asked only after it had already
 * committed. `bc-dgx7.41` was told twice by the claim guard and did nothing. This is
 * bc-3rjan's own working method, reusable and never touching the caller's tree.
 *
 * ## `git merge-tree --write-tree` never touches the working tree or the index
 *
 * That is the entire point of the plumbing bc-3rjan reached for by hand: given two
 * commit-ish refs it computes the merge and writes the resulting tree straight into the
 * object database, the same way `lib/gitref.js`'s `hashObject`/`commitToRef` write a
 * session's ref without a checkout ever happening. Nothing here runs `git checkout`,
 * `git merge` or `git stash` — the caller's worktree is provably untouched, which is
 * what `bc-3rjan`'s own acceptance criterion (byte-identical before and after, on the
 * failure path too) is checking for. `test/premerge.mjs` asserts it with `git status`
 * and a diff around every call, including the one that finds a conflict.
 *
 * A clean merge prints one line, the tree's oid, and exits `0`. A conflicted one still
 * writes a tree — with the conflict markers baked into the blob content of whatever it
 * could not resolve — prints that oid on the same first line, then one `<mode> <oid>
 * <stage>\t<path>` line per unresolved stage entry, and exits `1`. Stage `1` is the
 * merge base, `2` is our side, `3` is theirs; a delete/modify conflict is missing
 * whichever side deleted it. Either way the *set of paths* named in those lines is the
 * conflict list — `git show <tree>:<path>` reads the merged (possibly marker-laden)
 * blob straight back out, no different from reading any other blob at a tree.
 *
 * `git merge-tree` also exits `1` for a ref it cannot resolve at all (a typo, a branch
 * that shares no history) — indistinguishable from a real conflict by exit code alone,
 * which is why this checks the first line for a real tree oid rather than trusting the
 * exit code: a run whose first line is not 40 or 64 hex characters failed to run at all
 * and is reported as an error block, never as a conflict.
 *
 * ## Discovery reuses `lib/siblings.js`, never reimplements it
 *
 * With no `--against` named, the counterparties are whichever live worktrees
 * `siblingsFor` already finds touching the files this branch has changed since `main` —
 * the same survey `b7e-siblings` runs, just fed into a merge instead of only printed.
 * `--bead` swaps in a bead's declared files (`lib/beadfiles.js`) for that same call,
 * mirroring `bin/b7e-siblings`' own `--bead` exactly. `--against` skips discovery
 * entirely and merges against exactly the refs named, resolving a worktree *path* to
 * its branch the same way `lib/siblings.js` reads `git worktree list --porcelain`.
 *
 * ## `--tree` materialises the merge, once, replacing not accumulating
 *
 * `git archive <tree> | tar -x` unpacks the merge-tree's content — conflict markers and
 * all — into a plain directory under `os.tmpdir()`, keyed by the two ref names so a
 * second call for the same pair overwrites rather than piles up. `node_modules` is
 * symlinked in from the caller's own worktree, the same borrow-never-copy rule
 * `bin/b7e-worktree` and `lib/blame.js`'s `makeMainWorktree` already hold, so `node
 * test/<suite>.mjs` runs there without the caller linking anything by hand — which is
 * what bc-3rjan's manual `cp` back into its own working copy was standing in for.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './gitref.js';
import { parseWorktrees, realPath } from './tidy.js';
import { siblingsFor, BASE_REF } from './siblings.js';

const run = promisify(execFile);

/** A premerge is asked before a delivery, not instead of one — it must fail fast. */
const TIMEOUT_MS = 20000;

/** Lines of context printed either side of a conflict's markers. */
const CONTEXT = 2;

/** git args that stamp beadcause as the author of any object this writes. */
const IDENTITY = ['-c', 'user.name=beadcause', '-c', 'user.email=beadcause@localhost'];

const TREE_OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const STAGE_LINE_RE = /^\d+ [0-9a-f]{40,64} \d\t(.+)$/;

/**
 * Every file this checkout has changed since it forked from `BASE_REF` — committed and
 * uncommitted alike, the same "what has this branch actually done" `changedSince`
 * answers per-file in `lib/regions.js`. This is the default input to `siblingsFor` when
 * neither `--against` nor `--bead` named the files explicitly.
 */
export async function ownChangedFiles(dir) {
  const base = (await git(dir, ['merge-base', BASE_REF, 'HEAD']).catch(() => ''))?.trim();
  if (!base) return [];
  const diff = await git(dir, ['diff', '--name-only', base]).catch(() => '');
  const files = new Set(diff.split('\n').map((s) => s.trim()).filter(Boolean));
  // `git diff <base>` compares the index and working tree against `base`, so a staged or
  // committed addition already shows up — but a file that has never been `git add`ed at
  // all is invisible to `diff` regardless, the same untracked-file gap `changedSince`
  // (lib/regions.js) has to work around per-file. `status --porcelain` catches it here.
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
  for (const line of status.split('\n')) {
    if (line.startsWith('?? ')) files.add(line.slice(3).trim());
  }
  return [...files];
}

/**
 * A `--against` value — a branch name, or a worktree's path — resolved to a ref
 * `merge-tree` can take. A path that does not match any live worktree is assumed to
 * already be a ref (a branch, a tag, a sha) and passed through unchanged; `merge-tree`
 * itself is what actually rejects a name that resolves to nothing.
 */
export async function resolveRef(dir, value) {
  const porcelain = await git(dir, ['worktree', 'list', '--porcelain']).catch(() => null);
  if (!porcelain) return value;
  const real = realPath(path.resolve(value));
  const hit = parseWorktrees(porcelain).find((wt) => realPath(wt.path) === real);
  return hit && hit.branch ? hit.branch : value;
}

/**
 * `dir`'s own branch name — a short sha for a detached checkout — used in place of the
 * literal `HEAD` so a `--tree` slug names the branch it actually came from rather than
 * the word every checkout would otherwise share.
 */
export async function currentRef(dir) {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''))?.trim();
  if (branch && branch !== 'HEAD') return branch;
  const sha = (await git(dir, ['rev-parse', '--short', 'HEAD']).catch(() => ''))?.trim();
  return sha || 'HEAD';
}

/** git, run raw, without `gitref.js`'s "throw on any non-zero exit" — a conflict is not a bug. */
async function raw(dir, args) {
  try {
    const { stdout } = await run('git', [...IDENTITY, ...args], {
      cwd: dir,
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : -1, stdout: err.stdout || '', stderr: err.stderr || err.message || '' };
  }
}

/**
 * The simulated merge itself: `{ ok: true, clean, treeOid, conflictPaths, messages }` or
 * `{ ok: false, error }` for a ref this could not resolve at all. Never throws, never
 * touches `dir`'s working tree or index — see the module header.
 */
async function mergeTree(dir, ours, theirs) {
  const { code, stdout, stderr } = await raw(dir, ['merge-tree', '--write-tree', ours, theirs]);
  const lines = stdout.split('\n');
  const treeOid = (lines[0] || '').trim();
  if (!TREE_OID_RE.test(treeOid)) {
    return { ok: false, error: stderr.trim().split('\n')[0] || `merge-tree exited ${code} with no tree` };
  }
  if (code === 0) return { ok: true, clean: true, treeOid };

  const conflictPaths = [];
  const seen = new Set();
  const messages = [];
  for (const line of lines.slice(1)) {
    const m = STAGE_LINE_RE.exec(line);
    if (m) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        conflictPaths.push(m[1]);
      }
    } else if (line.trim()) {
      messages.push(line.trim());
    }
  }
  return { ok: true, clean: false, treeOid, conflictPaths, messages };
}

/**
 * Every `<<<<<<< / ======= / >>>>>>>` block in one conflicted file, as line ranges with
 * a little context — the same rendering `lib/regions.js`'s `render` gives a claim
 * refusal, read off the merged blob instead of a diff hunk. `null` for a path
 * `merge-tree` named as conflicted but whose merged blob carries no textual markers at
 * all (a rename, a mode change, an add/add on a binary) — the `messages` already say
 * what kind of conflict it was, and there is nothing this can honestly add.
 */
async function conflictHunks(dir, treeOid, file) {
  const { code, stdout } = await raw(dir, ['show', `${treeOid}:${file}`]);
  if (code !== 0) return null;
  const lines = stdout.split('\n');
  const hunks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('<<<<<<<')) start = i;
    else if (lines[i].startsWith('>>>>>>>') && start !== -1) {
      const from = start + 1;
      const to = i + 1;
      const ctxFrom = Math.max(0, start - CONTEXT);
      const ctxTo = Math.min(lines.length - 1, i + CONTEXT);
      hunks.push({
        range: from === to ? `${from}` : `${from}–${to}`,
        context: lines.slice(ctxFrom, ctxTo + 1),
      });
      start = -1;
    }
  }
  return hunks.length ? hunks : null;
}

/** Sanitised to a filesystem-safe slug — the tmpdir directory name for a `--tree` pair. */
const slug = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref';

/**
 * `git archive <treeOid> | tar -x` into a fresh directory under `os.tmpdir()`, keyed by
 * `ours`/`theirs` so a second call for the same pair replaces rather than accumulates —
 * the acceptance criterion bc-dgx7.52 names by name. `node_modules` is symlinked in from
 * `dir` (never copied), the same borrow this repo's own `bin/b7e-worktree` and
 * `lib/blame.js`'s `makeMainWorktree` already do, so `node test/<suite>.mjs` runs there
 * without the caller linking anything.
 */
export async function materializeTree(dir, treeOid, ours, theirs) {
  const root = path.join(fs.realpathSync(os.tmpdir()), 'beadcause-premerge');
  const target = path.join(root, `${slug(ours)}--${slug(theirs)}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  await new Promise((resolve, reject) => {
    const archive = spawn('git', [...IDENTITY, 'archive', treeOid], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', target], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    archive.stdout.pipe(tar.stdin);
    archive.stderr.on('data', (d) => (err += d));
    tar.stderr.on('data', (d) => (err += d));
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`b7e-premerge: --tree extraction failed: ${err.trim() || `exit ${code}`}`))));
  });

  const nmSource = path.join(dir, 'node_modules');
  const nmDest = path.join(target, 'node_modules');
  if (fs.existsSync(nmSource) && !fs.existsSync(nmDest)) {
    fs.symlinkSync(fs.realpathSync(nmSource), nmDest);
  }
  return target;
}

/**
 * The whole simulation for one counterparty: `{ branch, ok, error }` on a ref this
 * could not resolve; otherwise `{ branch, ok: true, clean, treeOid, conflicts?,
 * messages?, treeDir? }`. `conflicts` is one entry per conflicted path — `{ file,
 * hunks }`, `hunks` from `conflictHunks` above, `null` for a structural conflict with
 * no textual markers to show.
 */
export async function premergeAgainst(dir, ours, theirs, { tree = false } = {}) {
  const result = await mergeTree(dir, ours, theirs);
  if (!result.ok) return { branch: theirs, ok: false, error: result.error };

  const block = { branch: theirs, ok: true, clean: result.clean, treeOid: result.treeOid };
  if (!result.clean) {
    block.conflicts = await Promise.all(
      result.conflictPaths.map(async (file) => ({ file, hunks: await conflictHunks(dir, result.treeOid, file) }))
    );
    block.messages = result.messages;
  }
  if (tree) block.treeDir = await materializeTree(dir, result.treeOid, ours, theirs);
  return block;
}

/**
 * The counterparty branches nobody named explicitly: whichever live worktrees
 * `siblingsFor` finds touching `files`, deduplicated and excluding `dir`/`main`
 * themselves (`siblingsFor` already does both).
 */
export async function discoverCounterparties(dir, files, { cfg = {} } = {}) {
  const rows = await siblingsFor(dir, files, { cfg });
  return rows.map((r) => r.branch);
}

export { BASE_REF };
