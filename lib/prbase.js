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
 * **A workspace whose integration branch is not `main` says so once**, in
 * `pr.basePerWorkspace` — a map of workspace name to branch, and the setting for that
 * workspace wherever `pr.base` would otherwise have been. `deluvia` is why it exists:
 * its work lands on `atlas/public-launch`, not `main`, so every pull request opened
 * against the install-wide `pr.base` would target a branch deluvia never merges into.
 * One workspace being unusual must not make `main` wrong for the other nine, which is
 * the whole argument for a map rather than a different global.
 *
 * It sits *underneath* the repo, not over it: a multi-repo workspace still asks GitHub
 * first and reaches the override only on the fallback path. A single string cannot be
 * the right base for forty repos, and a workspace that has forty already has a better
 * answer per repo — so the override is what "the setting" means for that workspace, and
 * nothing more. In practice the two never meet: every workspace with an integration
 * branch of its own here is one repo.
 *
 * The override for one *delivery*, as opposed to one workspace, is still `--base` on
 * `bin/deliver.js`, and it still wins over both. A session that knows it is delivering
 * into something other than the workspace's or the repo's usual branch says so on the
 * command line, where it is visible in the log.
 */
import { defaultBranch } from './pr.js';
import { multiRepo } from './repos.js';

/**
 * The configured base: this workspace's own branch if it has one, then `pr.base`, then
 * the built-in default. The answer for every single-repo workspace.
 *
 * `workspaceName` is optional and an unknown one is simply absent from the map, so a
 * caller that has no workspace in hand — and one written before the map existed — gets
 * exactly what it always got.
 */
export function configuredBase(cfg = {}, workspaceName = '') {
  // `typeof` rather than a truthiness test on the lookup: a map keyed by workspace name
  // is hand-edited, and `{"deluvia": true}` must read as "nothing legible was asked
  // for" rather than as the branch `true`. Same rule the per-workspace booleans in
  // lib/spaces.js keep, for the same reason.
  const own = cfg?.pr?.basePerWorkspace?.[workspaceName];
  const mine = typeof own === 'string' ? own.trim() : '';
  return mine || String(cfg?.pr?.base || '').trim() || 'main';
}

/**
 * The branch work in `dir` should be delivered into.
 *
 * `dir` is the checkout the session ran in — a worktree is fine, `gh` resolves the
 * remote through the common directory like every other git question here.
 */
export async function baseFor(cfg = {}, workspaceName = '', dir = null) {
  const configured = configuredBase(cfg, workspaceName);
  if (!dir || !multiRepo(cfg, workspaceName)) return configured;
  return (await defaultBranch(dir)) || configured;
}
