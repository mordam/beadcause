/**
 * Where beadcause looks for trackers, and the two shapes a root can have.
 *
 *   ~/beads/sophab/.beads          a *container* root: one workspace per subdirectory
 *   ~/climative.dev/architecture   an *in-repo* root: the root IS the workspace
 *
 * The first is what `bd init` in `~/beads/<name>` produces and what discovery read for
 * as long as there was only one shape to read. The second is what a *team* tracker has:
 * Climative's `cl-` graph moved into the repo it tracks on 2026-08-12, because forty
 * service checkouts and the issues about them should arrive in one clone.
 *
 * ## Why this is its own module rather than a few more exports in lib/config.js
 *
 * lib/reposcan.js needs `containerRoots` — it has always refused to offer `~/beads` as a
 * place a workspace's checkouts might live, and that refusal has to follow the setting
 * rather than the literal path. But `test/reposcan.mjs` asserts, literally, that
 * reposcan.js does not import `./config.js`: discovery presented for approval is a
 * different thing from discovery applied, and one `saveConfig` reached for later "to be
 * helpful" would be the difference. That assertion is cheap and it guards the most
 * expensive possible mistake, so it is not the thing to weaken to save a file.
 *
 * Nothing here reads a tracker, writes anything, or knows what a config file is. A
 * workspace is a directory called `.beads`, and that is the whole test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './repos.js';

/**
 * The place a tracker lives on an install that has never been told otherwise.
 *
 * `~/beads/<name>/.beads` — a *container* directory with one subdirectory per
 * workspace. It is what `bd init` in `~/beads/sophab` produces, what
 * `scripts/install.sh` tells a fresh Mac to make, and what `workspaceRoots` below
 * defaults to, so that a config file written before this setting existed discovers
 * exactly what it discovered yesterday.
 */
// A function rather than a constant, and deliberately: `os.homedir()` reads `$HOME`
// afresh each call, and a dozen suites point `HOME` at a temp tree so discovery finds no
// real `~/beads` to reconcile onto their output. A value frozen at module load would be
// the *real* home in every one of them.
export const defaultWorkspaceRoot = () => path.join(os.homedir(), 'beads');

/**
 * Where to look for trackers: absolute, `~` expanded, deduped, in the order configured.
 *
 * A missing or empty `workspaceRoots` means the default, and that is the whole of the
 * compatibility story — every existing install keeps discovering `~/beads/*` and nothing
 * about it changes.
 *
 * Expanded here rather than at each reader because the readers compare paths: session
 * resolution asks whether two directories are the same directory, and `~/beads` and
 * `/Users/you/beads` are the same directory written two ways.
 */
export function workspaceRoots(cfg = {}) {
  const named = (Array.isArray(cfg?.workspaceRoots) ? cfg.workspaceRoots : []).filter(Boolean);
  const roots = (named.length ? named : [defaultWorkspaceRoot()]).map((r) => expandHome(r)).filter(Boolean);
  return [...new Set(roots)];
}

/**
 * Whether a root **is** a workspace rather than holding several.
 *
 * The two shapes, and the reason this setting exists at all. A *container* root has one
 * subdirectory per workspace (`~/beads/sophab/.beads`). A root with its own `.beads`
 * *is* the workspace, named after the directory it sits in — which is what a tracker
 * living inside the repo it tracks looks like, and Climative's `cl-` graph became exactly
 * that on 2026-08-12 when it moved to `~/climative.dev/architecture/.beads` so that forty
 * service checkouts and the issues about them ship in one clone.
 *
 * The distinction is not cosmetic, and lib/reposcan.js is where it bites: a container is
 * the tracker's own tree and nothing in it is a checkout anybody works in, which is why
 * `candidateRoot` refuses to offer one as a place repos live. An in-repo root is a
 * checkout somebody works in every day, and excluding *it* would be wrong. See
 * `containerRoots`.
 */
export const isRepoRoot = (root) => fs.existsSync(path.join(root, '.beads'));

/** The configured roots that hold workspaces rather than being one — see `isRepoRoot`. */
export const containerRoots = (cfg = {}) => workspaceRoots(cfg).filter((r) => !isRepoRoot(r));

/**
 * Every workspace under every configured root, in alphabetical order.
 *
 * Both shapes, per root, and nothing here reads a tracker — a workspace is a directory
 * called `.beads` and that is the whole test.
 *
 * **Two workspaces are never allowed to share a name**, and the second one found loses.
 * Almost everything else in this config is keyed by workspace name — `sessionDirs`,
 * `jira`, `advocates.perWorkspace`, the `workspaces` list of a space — so two trackers
 * called `climative` would silently share every one of those answers, and the one that
 * won would depend on the order two roots were typed in. Saying so and taking the first
 * is the only version of that with a log line in it.
 */
export function discoverWorkspaces(cfg = {}) {
  const found = [];
  for (const root of workspaceRoots(cfg)) {
    if (isRepoRoot(root)) {
      // The root is the workspace: a tracker that lives in the repo it tracks.
      found.push({ name: path.basename(root), dir: path.join(root, '.beads') });
      continue;
    }
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const dir = path.join(root, name, '.beads');
      if (fs.existsSync(dir)) found.push({ name, dir });
    }
  }

  // By directory first, because two roots can reach one tracker (a symlinked container,
  // or a root named both with and without a trailing slash) and that is not a clash —
  // it is the same workspace twice, and saying so out loud would be noise.
  const seenDir = new Set();
  const seenName = new Set();
  const kept = [];
  for (const w of found) {
    if (seenDir.has(w.dir)) continue;
    seenDir.add(w.dir);
    if (seenName.has(w.name)) {
      console.warn(`[beadcause] ignoring ${w.dir} — a workspace called ${w.name} was already found under an earlier root`);
      continue;
    }
    seenName.add(w.name);
    kept.push(w);
  }
  return kept.sort((a, b) => a.name.localeCompare(b.name));
}

