/**
 * Read a pull request's files at its head — without ever writing `FETCH_HEAD` or a
 * branch, so a sibling session sharing this checkout is never moved out from under it.
 * `bin/b7e-head` is the argv parsing and printing around this; everything that actually
 * decides *which tree* lives here.
 *
 * bc-dgx7.37: three ReviewAdvocate runs before this one each answered "read this pull
 * request's files" by hand, and two of the three ways were wrong in a way that never
 * announced itself:
 *
 * - bc-36xx.9 ran `git fetch -q origin <branch>` and read `FETCH_HEAD` fourteen times —
 *   the *branch*, not the pull request's head. A resolver pushing mid-review moves that
 *   ref out from under the review that is reading it.
 * - bc-zjab.12 fetched the branch into `FETCH_HEAD` too, then built a sandbox from it. A
 *   concurrent session in the same checkout overwrote `FETCH_HEAD` before the sandbox
 *   was built, so the sandbox — and the suite run against it — was silently main, not
 *   the pull request. It found out by accident, from a later `gh pr view --json
 *   headRefOid` that disagreed with `git rev-parse FETCH_HEAD`.
 * - bc-36xx.22 got the *tree* right (`git fetch origin pull/<n>/head:pr<n>-review
 *   --force`) but paid for it with a branch every other session in the shared checkout
 *   sees in `git branch` for as long as the review runs.
 *
 * The fix underneath all three: resolve the head from `gh pr view --json headRefOid`
 * (never a branch name, so a push mid-review cannot move the answer), fetch *that
 * specific commit* with `--no-write-fetch-head` (so nothing here ever writes
 * `FETCH_HEAD`), and read it with plumbing that takes a bare commit — `git cat-file`,
 * `git ls-tree`, `git grep`, `git archive` — every one of which is happy to be handed a
 * sha instead of a ref and touches no ref of its own. No branch, ever, so there is
 * nothing here for `git branch --list` to show and nothing to `git branch -D` on the
 * way out.
 *
 * ## What this reuses
 *
 * - **`lib/pr.js`'s `headOf`** — the one `gh` call this needs: `headRefOid`,
 *   `baseRefOid`, `baseRefName`, `headRefName`, and `files` (GitHub's own diff, already
 *   computed to render the pull request's "Files changed" tab — no `git diff` to run,
 *   and no base commit to have fetched first).
 * - **`lib/gitref.js`'s `readRefFile`/`listRefTree`** — both already take any
 *   commit-ish, sha included, because they were written for a payload ref rather than a
 *   branch. `--file` is `readRefFile` under a new name; nothing new to write.
 * - **The `git archive <sha> | tar -x -C $dest` trick** — sitting until now as prose in
 *   the note `review-sandbox-by-git-archive`, spelled three different ways by the three
 *   sessions above, one of them silently wrong. `materialize` below is the one place it
 *   is now a program: `git archive` needs the commit's objects already fetched, same as
 *   every other mode here.
 *
 * ## What `--grep` does not reuse
 *
 * The bead that filed this asked for "this repo's roots and exclusions already
 * decided, same as `b7e-grep` would" — there is no `b7e-grep` in this tree to match, and
 * nothing else in `lib/` names a shared root/exclusion list for a source grep (the
 * nearest thing, `lib/commonrepo.js`'s secret scan, is a fixed pattern list over staged
 * config files, not a general search). So `grepTree` below searches the whole head tree
 * by default, exactly like a bare `git grep` would, and takes `paths` to narrow it —
 * the ordinary git syntax, not an invented default list. If a real root/exclusion
 * convention lands later, this is the one place that would need to change.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { git, ok, readRefFile, listRefTree, mainCheckout } from './gitref.js';
import * as pr from './pr.js';

export { mainCheckout };

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Refuse anything that is not a full 40-character sha — never a branch, ever. */
function assertSha(oid) {
  const s = String(oid || '');
  if (!FULL_SHA.test(s)) throw new Error(`not a full commit sha: ${JSON.stringify(oid)}`);
  return s;
}

/**
 * Which commit this pull request's head actually is, right now — see `lib/pr.js`'s
 * `headOf` for why this is the one call, and never a branch read.
 */
export async function resolveHead(dir, prRef) {
  const info = await pr.headOf(dir, prRef);
  if (!info.headOid) throw new Error(`gh has no headRefOid for pull request ${prRef}`);
  return info;
}

/**
 * Fetch one commit's objects into this checkout's object store, writing no ref at all —
 * not `FETCH_HEAD`, not a branch. `--no-write-fetch-head` is the whole fix for
 * bc-zjab.12: two of these racing on the same shared checkout write into the same
 * content-addressed object store and never collide, because neither of them writes
 * anywhere both could read a stale answer from.
 *
 * Needs `uploadpack.allowReachableSHA1InWant` on the remote, which GitHub has had on by
 * default for years — fetching an arbitrary reachable sha, not just a ref tip, is
 * exactly what a pull request's head commit is once anything else on the repo has ever
 * fetched a ref that contains it.
 */
export async function fetchHead(dir, oid) {
  await git(dir, ['fetch', '--no-write-fetch-head', 'origin', assertSha(oid)]);
}

/** One file's bytes at the head commit, or `null` if it does not exist in that tree. */
export async function fileAt(dir, oid, filePath) {
  return readRefFile(dir, assertSha(oid), filePath);
}

/** Every path in the head tree, optionally narrowed to one subtree. */
export async function listTree(dir, oid) {
  return listRefTree(dir, assertSha(oid));
}

/**
 * `git grep` over the head tree — no ref, no checkout, the same plumbing `--file` and
 * `--tree` use underneath. `paths`, when given, is passed straight through as `git`'s
 * own pathspec list after `--`; empty searches the whole tree.
 *
 * A pattern that matches nothing and a pattern `git` itself refuses both come back as
 * an empty list here (`ok()` swallows both), the same simplification
 * `lib/commonrepo.js`'s own `git grep` calls already make — see its note on
 * `FORBIDDEN_FIELDS` two of which are split apart for exactly this reason.
 */
export async function grepTree(dir, oid, pattern, paths = []) {
  const sha = assertSha(oid);
  const args = ['grep', '-n', '-I', '--extended-regexp', String(pattern), sha];
  if (paths.length) args.push('--', ...paths);
  const out = await ok(git(dir, args));
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(sha.length + 1); // drop the leading "<sha>:"
      const m = rest.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { file: '', line: 0, text: rest };
    });
}

/** The changed-files half of `resolveHead`'s answer, GitHub's own diff — `--list`'s payload. */
export function changedFiles(headInfo) {
  return headInfo.files || [];
}

/** Where every `--tree` materialisation lives — `os.tmpdir()`, never inside this checkout. */
export function treeRoot() {
  return path.join(os.tmpdir(), 'beadcause-b7ehead');
}

/**
 * Materialise the head commit into a plain directory a suite can be run in — the
 * `review-sandbox-by-git-archive` trick, finally a program. Keyed by head oid under
 * `os.tmpdir()`, so a second call for the same pull request (nothing has moved) reuses
 * the directory instead of re-extracting it, and two different pull requests being
 * reviewed at once never share one.
 *
 * `node_modules` is symlinked in from this checkout's own main working tree — the other
 * half of the note — so a suite run inside the sandbox does not need its own `npm ci`.
 * Silently skipped if this checkout has none (a fresh clone that never ran one itself).
 */
export async function materialize(dir, oid) {
  const sha = assertSha(oid);
  const dest = path.join(treeRoot(), sha);
  const marker = path.join(dest, '.b7e-head-ok');
  if (fs.existsSync(marker)) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await archiveInto(dir, sha, dest);
  const main = await mainCheckout(dir);
  const nm = path.join(main, 'node_modules');
  if (fs.existsSync(nm)) {
    try {
      fs.symlinkSync(nm, path.join(dest, 'node_modules'));
    } catch {
      /* a concurrent materialize of the same oid already linked it */
    }
  }
  fs.writeFileSync(marker, '');
  return dest;
}

/** `git archive <sha> | tar -x -C dest`, without a shell — the pipe is built by hand. */
function archiveInto(dir, sha, dest) {
  return new Promise((resolve, reject) => {
    const arc = spawn('git', ['archive', sha], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let archErr = '';
    let tarErr = '';
    arc.stderr.on('data', (d) => (archErr += d));
    tar.stderr.on('data', (d) => (tarErr += d));
    arc.stdout.pipe(tar.stdin);
    let archCode = null;
    let tarCode = null;
    let failed = null;
    const settle = () => {
      if (archCode === null || tarCode === null) return;
      if (failed) return reject(failed);
      if (archCode !== 0) return reject(new Error(`git archive: ${archErr.trim() || `exited ${archCode}`}`));
      if (tarCode !== 0) return reject(new Error(`tar -x: ${tarErr.trim() || `exited ${tarCode}`}`));
      resolve(dest);
    };
    arc.on('error', (err) => {
      failed = failed || err;
      archCode = archCode ?? -1;
      settle();
    });
    tar.on('error', (err) => {
      failed = failed || err;
      tarCode = tarCode ?? -1;
      settle();
    });
    arc.on('close', (code) => {
      archCode = code;
      settle();
    });
    tar.on('close', (code) => {
      tarCode = code;
      settle();
    });
  });
}
