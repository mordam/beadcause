/**
 * What this branch actually ships, and whether `bin/deliver.js` would refuse it — right
 * now, before the summary prose is written.
 *
 * bc-khoe.27.10 is the audit: five sessions (bc-khoe.27.5, bc-fh0sz, bc-xl7n.109,
 * bc-gdub, bc-khoe.27.7) each asked "what does my branch change against main" with a
 * different git incantation, and two of them hit `bin/deliver.js`'s own refusals —
 * main-into-main, and a dirty tree — only after the delivery summary had already been
 * written. This is the one answer, computed the same way `bin/deliver.js` itself decides
 * it, so this command's verdict and that command's exit code cannot drift apart.
 *
 * THE BASE. Not a bare `git diff main...HEAD`, which bc-gdub.1 hit exactly this way: in
 * a fresh worktree the local `main` ref is whatever it was when the worktree's object
 * store last saw it, and asking `main...HEAD` for a symmetric difference against a
 * *stale* local ref can answer empty even though the branch plainly has commits of its
 * own. `resolveBase` fetches `origin/<base>` first and takes the merge-base of *that*
 * against `HEAD` — the same freshness `bin/deliver.js` itself relies on (its own `git
 * fetch origin <base>` a few lines before the ahead-count).
 *
 * THE VERDICT. `deliverVerdict` is deliver.js's own three guard clauses — detached
 * HEAD, branch-equals-base, a dirty tree — transplanted verbatim, in the same order,
 * with the same wording, so a session reads the identical sentence here that it would
 * get from the real refusal, before it has written a word of delivery prose.
 *
 * WHAT THIS DOES NOT CHECK. It does not replicate `lib/conflicted.js`'s
 * `inspectBranch` (a committed merge conflict marker, or a commit that no longer
 * parses) — that is a check on the *committed* blobs deliver.js runs after these two,
 * and it is a different question from "what does this branch ship and is the tree
 * clean enough to ship it". It also never pushes, opens anything, or talks to `gh` —
 * every read here is local, so running it costs nothing and changes nothing.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** git, without beadcause's own IDENTITY override — this only ever reads. */
async function git(cwd, args) {
  try {
    const { stdout } = await run('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error(`git ${args[0]}: ${String(err.stderr || err.message || '').trim().split('\n')[0]}`);
  }
}

/** A git call's stdout, or null rather than a throw — for a ref that may not exist. */
async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** The current branch, or `null` on a detached HEAD (git prints the literal `HEAD`). */
export async function branchOf(dir) {
  const out = (await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (!out || out === 'HEAD') return null;
  return out;
}

/**
 * The base to compare against: `origin/<baseRef>`'s merge-base with `HEAD`, fetched
 * fresh first. Falls back to a local `<baseRef>` branch when there is no `origin`
 * remote at all (a fixture repo, an offline clone with no push target) — offline
 * against a real remote falls back the same way `bin/deliver.js`'s own fetch does,
 * using whatever `origin/<baseRef>` this checkout last saw.
 *
 * Returns `{ ref, sha, method, fetched }`; `sha` is `null` only when neither
 * `origin/<baseRef>` nor a local `<baseRef>` resolves at all, which is a repo with no
 * base to speak of rather than an ordinary failure.
 */
export async function resolveBase(dir, baseRef = 'main') {
  let fetched = false;
  try {
    await git(dir, ['fetch', 'origin', baseRef, '--quiet']);
    fetched = true;
  } catch {
    /* offline, or no such remote — the remote-tracking ref below is whatever is left. */
  }
  const remoteRef = `origin/${baseRef}`;
  const remoteTip = (await gitOrNull(dir, ['rev-parse', '--verify', '--quiet', remoteRef]))?.trim();
  if (remoteTip) {
    const sha = (await git(dir, ['merge-base', remoteRef, 'HEAD'])).trim();
    const method = fetched
      ? `merge-base against freshly fetched ${remoteRef}`
      : `merge-base against ${remoteRef} (fetch failed — offline or no remote; using the last-known ref)`;
    return { ref: remoteRef, sha, method, fetched };
  }
  const localTip = (await gitOrNull(dir, ['rev-parse', '--verify', '--quiet', baseRef]))?.trim();
  if (localTip) {
    const sha = (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim();
    return { ref: baseRef, sha, method: `merge-base against local ${baseRef} (no ${remoteRef} remote-tracking ref)`, fetched };
  }
  return { ref: baseRef, sha: null, method: `neither ${remoteRef} nor a local ${baseRef} resolves`, fetched };
}

/** The committed diff between a resolved base sha and HEAD — files, a stat, and a count. */
export async function committedDiff(dir, baseSha) {
  const names = (await git(dir, ['diff', '--name-only', baseSha, 'HEAD'])).split('\n').filter(Boolean);
  const stat = (await git(dir, ['diff', '--stat', baseSha, 'HEAD'])).trimEnd();
  const ahead = Number((await git(dir, ['rev-list', '--count', `${baseSha}..HEAD`])).trim()) || 0;
  return { files: names, stat, ahead };
}

/**
 * Every path `git status --porcelain` names — staged, unstaged or untracked alike —
 * which is exactly the set `bin/deliver.js`'s own dirty check reads: it asks nothing
 * more specific than "is this non-empty", so every path named here is one deliver.js
 * would refuse over, together, in one message.
 */
export async function workingTreeStatus(dir) {
  const raw = await git(dir, ['status', '--porcelain']);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), file: line.slice(3) }));
}

/**
 * `bin/deliver.js`'s own three guard clauses, in its own order and its own wording —
 * so the sentence a session reads here is the sentence it would get from the real
 * refusal, not a paraphrase of it. `base` is the ref name (e.g. `origin/main` or
 * `main`) deliver.js would have resolved to, for the branch-equals-base check — which
 * deliver.js makes against the *branch name*, not the remote-tracking form, so a
 * caller passing `origin/main` here should strip the remote before calling.
 */
export function deliverVerdict({ branch, base, dirty }) {
  if (!branch) {
    return { refuses: true, reason: 'this checkout is on a detached head; a PR needs a branch' };
  }
  if (['main', 'master', base].includes(branch)) {
    return {
      refuses: true,
      reason: `refusing to open a PR from ${branch} into ${base} — the work should be on its own branch`,
    };
  }
  if (dirty.length) {
    const list = dirty.map((d) => `${d.status} ${d.file}`).join('\n');
    return {
      refuses: true,
      reason: `the worktree has uncommitted changes — commit them first, they are not in the PR:\n${list}`,
    };
  }
  return { refuses: false, reason: null };
}

/**
 * The whole answer, one call: base resolution, the committed diff against it, the
 * dirty working tree, and the verdict `bin/deliver.js` would reach right now.
 */
export async function shipcheck(dir, { baseRef = 'main' } = {}) {
  const branch = await branchOf(dir);
  const base = await resolveBase(dir, baseRef);
  const diff = base.sha ? await committedDiff(dir, base.sha) : { files: [], stat: '', ahead: 0 };
  const dirty = await workingTreeStatus(dir);
  const verdict = deliverVerdict({ branch, base: baseRef, dirty });
  return { branch, base, diff, dirty, verdict };
}
