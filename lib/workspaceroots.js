/**
 * Where beadcause looks for trackers: the roots it reads, and the names pinned by hand.
 *
 *   ~/beads/sophab/.beads          a *container* root: one workspace per subdirectory
 *   ~/climative.dev/architecture   an *in-repo* root: the root IS the workspace
 *   "workspaceDirs": {"x": "…"}    one name, pinned, wherever it lives
 *
 * The first is what `bd init` in `~/beads/<name>` produces and what discovery read for
 * as long as there was only one shape to read. The second is what a *team* tracker has:
 * Climative's `cl-` graph moved into the repo it tracks on 2026-08-12, because forty
 * service checkouts and the issues about them should arrive in one clone.
 *
 * ## Two settings, and which question each answers
 *
 * `workspaceRoots` (bc-x9u5) says **where to look**, and everything under a root is
 * found for as long as it is there — add the root once and a workspace created under it
 * next month arrives on its own. `workspaceDirs` (bc-odhk) names **one workspace**, and
 * that is the answer when the tracker is somewhere nothing sensible could be a root, or
 * when the point is `null` — taking a name out and *keeping* it out, which no amount of
 * looking can express. They compose in one order: roots are read first, a named
 * directory then wins over anything discovery found under that name, and an excluded
 * name is dropped however it arrived.
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

/** Is there a directory here? `false` for a file, a broken link, or nothing at all. */
export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

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
 * The two shapes, and the reason `workspaceRoots` exists at all. A *container* root has
 * one subdirectory per workspace (`~/beads/sophab/.beads`). A root with its own `.beads`
 * *is* the workspace, named after the directory it sits in — which is what a tracker
 * living inside the repo it tracks looks like.
 *
 * The distinction is not cosmetic, and lib/reposcan.js is where it bites: a container is
 * the tracker's own tree and nothing in it is a checkout anybody works in, which is why
 * `candidateRoot` refuses to offer one as a place repos live. An in-repo root is a
 * checkout somebody works in every day, and excluding *it* would be wrong. See
 * `containerRoots`.
 */
export const isRepoRoot = (root) => isDirectory(path.join(root, '.beads'));

/** The configured roots that hold workspaces rather than being one — see `isRepoRoot`. */
export const containerRoots = (cfg = {}) => workspaceRoots(cfg).filter((r) => !isRepoRoot(r));

/**
 * `workspaceDirs` read into the two things it says, plus what was wrong with it.
 *
 * Returns `{ named, excluded, problems }`. `named` is `[{name, dir}]` for the
 * workspaces pinned to a directory; `excluded` is the set of names never to serve,
 * however they were found; `problems` is one sentence per entry that could not be read,
 * for the caller to log.
 *
 * A value is either **a directory** or **`null`**, and the two are opposite halves of
 * the same problem — see the `workspaceDirs` block in `defaults()` for why both are
 * needed and why neither can be inferred. Everything else is a problem rather than a
 * guess: `{"climative": true}` is somebody meaning something we cannot know.
 *
 * The directory may be written either way. `~/climative.dev/architecture` and
 * `~/climative.dev/architecture/.beads` both name the same workspace, and refusing the
 * first would be refusing the path a person actually has in their head — the checkout
 * is the thing they know, the `.beads` inside it is beads' business. `~` expands,
 * because this key is hand-edited and an absolute path with somebody's username in it
 * is the kind of line that gets copied onto a second Mac.
 *
 * A named directory that is not there is a **warning and not a refusal**: the entry is
 * dropped and discovery still answers for that name if a root has one. A typo must be
 * loud — a workspace silently not served is the exact failure this key exists to end —
 * but it must not also take out a workspace that was working.
 */
export function namedWorkspaces(cfg) {
  const block = cfg?.workspaceDirs;
  const named = [];
  const excluded = new Set();
  const problems = [];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { named, excluded, problems };
  for (const [name, raw] of Object.entries(block)) {
    if (raw === null) {
      excluded.add(name);
      continue;
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      problems.push(`workspaceDirs.${name} is neither a directory nor null — ignoring it`);
      continue;
    }
    const given = expandHome(raw);
    const dir = path.basename(given) === '.beads' ? given : path.join(given, '.beads');
    if (!isDirectory(dir)) {
      problems.push(`workspaceDirs.${name} names ${dir}, which is not a directory — that workspace is not served`);
      continue;
    }
    named.push({ name, dir });
  }
  return { named, excluded, problems };
}

/**
 * Everything under every configured root, before `workspaceDirs` has its say.
 *
 * Both shapes, per root, and nothing here reads a tracker — a workspace is a directory
 * called `.beads` and that is the whole test.
 *
 * **Two workspaces found by looking are never allowed to share a name**, and the second
 * one loses. Almost everything else in the config is keyed by workspace name —
 * `sessionDirs`, `jira`, `advocates.perWorkspace`, the `workspaces` list of a space — so
 * two trackers called `climative` would silently share every one of those answers, and
 * which won would depend on the order two roots were typed in. Saying so and taking the
 * first is the only version of that with a log line in it. A name pinned in
 * `workspaceDirs` is the exception and wins outright, below: naming one is a more
 * specific statement than a directory happening to be there.
 */
function foundUnderRoots(cfg) {
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
  const byName = new Map();
  for (const w of found) {
    if (seenDir.has(w.dir)) continue;
    seenDir.add(w.dir);
    if (byName.has(w.name)) {
      console.warn(`[beadcause] ignoring ${w.dir} — a workspace called ${w.name} was already found under an earlier root`);
      continue;
    }
    byName.set(w.name, w);
  }
  return byName;
}

/**
 * Every workspace this install serves, in alphabetical order: whatever the roots hold,
 * plus whatever `workspaceDirs` names, minus whatever it excludes.
 *
 * The roots stay the rule and the named entries are the exception, deliberately — an
 * install that has never configured anything still finds its workspaces under `~/beads`,
 * which is what makes the first run work at all. A named directory **wins** over one a
 * root turned up under the same name, because two entries called `climative` pointing at
 * two graphs is the one outcome nothing downstream could make sense of.
 */
export function discoverWorkspaces(cfg = {}) {
  const { named, excluded } = namedWorkspaces(cfg);
  const byName = foundUnderRoots(cfg);
  for (const w of named) byName.set(w.name, w);
  for (const name of excluded) byName.delete(name);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Would looking alone have found this exact workspace?
 *
 * Asked by `adoptHandAddedWorkspaces`, which turns a `workspaces` entry somebody wrote
 * by hand into a `workspaceDirs` rule — and must not do that to one a root already
 * covers. Before `workspaceRoots` existed the question was "is it `~/beads/<name>`",
 * which is now only the default case of it: pinning a workspace the roots already reach
 * would freeze it in place, so that renaming its directory drops it rather than moving
 * it, which is the rot the pin exists to prevent everywhere else.
 */
export function isDiscoverable(cfg, entry) {
  if (!entry?.name || !entry?.dir) return false;
  const found = foundUnderRoots(cfg).get(entry.name);
  return Boolean(found) && path.resolve(found.dir) === path.resolve(entry.dir);
}
