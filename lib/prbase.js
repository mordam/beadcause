/**
 * Which branch a pull request is opened into, when the workspace is more than one repo.
 *
 * `pr.base` is a single string in the config and it has been the whole answer since
 * there were pull requests here, because until Climative every workspace was exactly
 * one repo and one repo has exactly one base. A workspace that holds forty of them has
 * forty bases, and no single setting can name them — the same argument `resolveSessionDir`
 * makes about `sessionDirs` in lib/session.js, which pins one directory for a workspace
 * that has no one directory to pin.
 *
 * So the rule is: **one repo, the setting; many repos, the repo.**
 *
 * - A workspace with no `repos` block — `sophab`, `deluvia`, `ehatt`, `beadcause` itself
 *   — answers `pr.base` and asks nothing of the network. Nothing that is one repo today
 *   changes answer, and nothing that is one repo today pays for a `gh` call it does not
 *   need.
 * - A multi-repo workspace asks GitHub what that repo's default branch is, and falls
 *   back to `pr.base` only when GitHub will not say — no `gh`, not authenticated, no
 *   remote, offline. Falling back rather than refusing is deliberate: a base that is
 *   wrong is caught immediately by `gh pr create`, which will not open a pull request
 *   into a branch that does not exist, and refusing outright would take a whole repo out
 *   of reach whenever the network was down.
 *
 * **Why GitHub and not the checkout** is argued beside `defaultBranch` in lib/pr.js, and
 * it is the surprising half: `refs/remotes/origin/HEAD` is written by `clone` and never
 * refreshed, so three of the forty-seven Climative checkouts on this Mac name a default
 * branch GitHub disagrees with — one of them a feature branch.
 *
 * The override, for the case neither of those covers, is `--base` on
 * `bin/deliver.js`. A session that knows it is delivering into something other than the
 * repo's default branch says so on the command line, where it is visible in the log, and
 * there is deliberately no per-repo config key for it: a base branch written down in a
 * JSON file on one Mac is exactly the kind of copy lib/repos.js refuses to keep of a
 * service token.
 */
import { defaultBranch } from './pr.js';
import { multiRepo } from './repos.js';

/** `pr.base`, or the built-in default. The answer for every single-repo workspace. */
export function configuredBase(cfg = {}) {
  return String(cfg?.pr?.base || '').trim() || 'main';
}

/**
 * The branch work in `dir` should be delivered into.
 *
 * `dir` is the checkout the session ran in — a worktree is fine, `gh` resolves the
 * remote through the common directory like every other git question here.
 */
export async function baseFor(cfg = {}, workspaceName = '', dir = null) {
  const configured = configuredBase(cfg);
  if (!dir || !multiRepo(cfg, workspaceName)) return configured;
  return (await defaultBranch(dir)) || configured;
}
