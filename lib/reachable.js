/**
 * Rule 1 (`docs/APPROVAL_PIPELINE.md` in a workspace repo, not this one): a path into a
 * checkout is only reachable from a phone once it is on trunk — nothing else is servable
 * outside the Mac that has it checked out. Three sessions working `dv-gr6.41`'s Story
 * chain (`dv-5eu.1.1`, `dv-gr6.41`, `dv-gr6.43`) each re-derived that by hand, on a branch
 * that was not trunk, and published an Artifact instead. This is the derivation, made once
 * — no network call, so it works offline and does not depend on GitHub knowing the repo.
 */
import { execFileSync } from 'node:child_process';

function git(dir, args) {
  try {
    // Every call here is expected to fail on an ordinary path — no origin, no `main`, not
    // even a git checkout — so stderr is piped rather than inherited: left at the default,
    // git's raw "fatal: ..." would print straight to the real terminal on every one of
    // those, even though the failure is caught and handled right here.
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/** The branch checked out at `dir`, or '' when `dir` is not inside a git repository. */
export function currentBranch(dir) {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * The repo's trunk branch at `dir` — the local `origin/HEAD` symbolic ref first, so a
 * repo whose default branch is not `main` is still read correctly with no network call;
 * `main` then `master`, whichever exists locally, when there is no such ref (a checkout
 * that has never fetched, or has no `origin` at all). `''` when none of the three answer.
 */
export function trunkBranch(dir) {
  const symbolic = git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic) return symbolic.replace(/^refs\/remotes\/origin\//, '');
  for (const name of ['main', 'master']) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', name])) return name;
  }
  return '';
}

/**
 * Whether a repo path written from `dir` right now would reach a phone.
 *
 * `reachable` is `null`, not `false`, when the question cannot be answered at all — `dir`
 * is not a git checkout, or no trunk name can be found — because that is a different fact
 * from "this branch is not trunk" and a caller silently treating them alike would tell a
 * session its packet is unreachable when the true answer is that this function does not
 * know.
 */
export function rule1Verdict(dir) {
  const branch = currentBranch(dir);
  if (!branch) {
    return { reachable: null, branch: '', trunk: '', message: `${dir} is not a git checkout — cannot say whether a path in it would reach a phone.` };
  }
  const trunk = trunkBranch(dir);
  if (!trunk) {
    return { reachable: null, branch, trunk: '', message: `could not tell this checkout's trunk branch — cannot say whether a path in it is phone-reachable.` };
  }
  const reachable = branch === trunk;
  const message = reachable
    ? `this checkout is on \`${trunk}\` — a repo path in the packet will reach a phone.`
    : `this checkout is on \`${branch}\`, not \`${trunk}\` — a repo path in the packet will 404 on a phone. Publish an Artifact and pass --artifact <url> instead.`;
  return { reachable, branch, trunk, message };
}
