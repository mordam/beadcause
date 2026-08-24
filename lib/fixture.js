/**
 * A disposable git tree with a history and a suite — the piece bc-68ou.14,
 * bc-khoe.30.17, bc-khoe.30.18, bc-4r10.22 and bc-68ou.15 each built by hand, five
 * different ways, every time a `b7e-*` command needed a tree that is not this repo to
 * point `--dir` at (see bin/b7e-fixture for the incident each of those left behind).
 *
 * **Nothing here ever writes inside this repo, or a real workspace.** Every tree lives
 * under `os.tmpdir()/beadcause-fixture/<name>`, in a container that holds the actual git
 * working tree (`repo/` — this is the path handed back), a bare remote (`remote.git`,
 * registered as `origin`) ready for whatever wants to push a branch at it the way
 * bc-68ou.15 needed one, and — only when `--keep` was passed — a marker file so a later
 * call with the same name refuses rather than silently deleting kept state. A second
 * call with the same name that was *not* kept tears the container down and rebuilds it
 * fresh, which is the regeneration bc-68ou.14's `mkfixture.sh` did by hand between every
 * run.
 *
 * Every commit is made under this file's own committer identity
 * (`b7e-fixture <b7e-fixture@localhost>`, passed as `-c` flags *and* as
 * `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME`/etc on every git call — the environment
 * variables outrank `-c user.name`, so `-c` alone would only mean "not the ambient git
 * config *file*") — never the machine's ambient identity, however it is set, so a
 * fixture built on a machine with no git identity configured at all still works, and a
 * test can tell a fixture's own commits apart from anything it might commit itself
 * inside the same tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Where every fixture lives — one subdirectory per `--name`, never under `os.homedir()`. */
export function fixtureRoot() {
  return path.join(os.tmpdir(), 'beadcause-fixture');
}

const IDENTITY = ['-c', 'user.name=b7e-fixture', '-c', 'user.email=b7e-fixture@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

// `GIT_AUTHOR_NAME` and friends, when set in the environment, outrank `-c user.name` —
// so `-c` alone is not "not the ambient git config", it is "not the ambient git config
// *file*". A caller (or its shell) exporting those four is exactly what "ambient"
// means here, so every call gets them pinned to the same identity explicitly.
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'b7e-fixture',
  GIT_AUTHOR_EMAIL: 'b7e-fixture@localhost',
  GIT_COMMITTER_NAME: 'b7e-fixture',
  GIT_COMMITTER_EMAIL: 'b7e-fixture@localhost',
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY_ENV } });
}

/** A path under `test/` ending in `.mjs` — the shape `scripts/test.mjs` discovers. */
function isSuitePath(relPath) {
  const parts = relPath.split('/');
  return parts[0] === 'test' && relPath.endsWith('.mjs');
}

/**
 * Guard against the one mistake this file exists to make impossible: a `--file` path
 * that escapes the tree it was meant to write inside (`../../etc/passwd`, an absolute
 * path). Thrown, not logged — a fixture that cannot prove this about itself must not be
 * handed back as though it were safe to build a command's `--dir` from.
 */
function assertContained(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`refusing to write outside the fixture: ${t} is not under ${r}`);
  }
}

/**
 * Build one. `opts`:
 *
 *   name    slug — the fixture lives at `fixtureRoot()/<name>` and a second call with
 *           the same name tears the first down first, unless it was `--keep`.
 *   steps   an ordered array of `{ type: 'file', path, content }` or
 *           `{ type: 'commit', message }`, in the order the caller wants them applied —
 *           see bin/b7e-fixture for how `--file`/`--commit` become this. Anything
 *           written after the last commit step is left uncommitted on purpose: that is
 *           what reproduces bc-68ou.14's cp-smoke (one commit, an uncommitted fix).
 *   keep    if true, a later call with the same `name` refuses rather than deleting.
 *
 * Returns `{ dir, commits, branches, remote, suites }` — see bin/b7e-fixture for what
 * each field means to a caller. `dir` is the git working tree itself, so
 * `b7e-counterproof --dir "$(b7e-fixture ...)"` needs nothing else.
 */
export function buildFixture({ name, steps = [], keep = false } = {}) {
  if (!name || !NAME_RE.test(name)) {
    throw new Error(`a fixture needs a --name that looks like a slug (letters, digits, "." "_" "-"), got ${JSON.stringify(name)}`);
  }

  const root = fixtureRoot();
  fs.mkdirSync(root, { recursive: true });
  const container = path.join(root, name);
  assertContained(root, container);
  const keepMarker = path.join(container, '.kept-by-a-previous-run');

  if (fs.existsSync(container)) {
    if (fs.existsSync(keepMarker)) {
      throw new Error(`fixture "${name}" was kept by a previous run (${container}) — remove it by hand, or pick a different --name`);
    }
    fs.rmSync(container, { recursive: true, force: true });
  }
  fs.mkdirSync(container, { recursive: true });

  const work = path.join(container, 'repo');
  assertContained(root, work);
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-q']);

  const remote = path.join(container, 'remote.git');
  assertContained(root, remote);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ['init', '-q', '--bare']);
  git(work, ['remote', 'add', 'origin', remote]);

  const commits = [];
  const suites = new Set();

  for (const step of steps) {
    if (step.type === 'file') {
      const full = path.join(work, step.path);
      assertContained(work, full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, step.content);
      if (isSuitePath(step.path)) suites.add(full);
    } else if (step.type === 'commit') {
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '--allow-empty', '-m', step.message]);
      const sha = git(work, ['rev-parse', 'HEAD']).trim();
      commits.push({ sha, message: step.message });
    } else {
      throw new Error(`unrecognised fixture step type: ${step.type}`);
    }
  }

  // `--short HEAD` resolves even for an unborn branch (zero commits so far), because
  // `git init` without `-b` (deliberately, so `init.defaultBranch=main` above decides
  // it the same way for every version of git this runs on) points HEAD at the branch
  // name before it exists.
  const branch = git(work, ['symbolic-ref', '--short', 'HEAD']).trim();

  if (keep) {
    fs.writeFileSync(keepMarker, 'kept — a later run of this fixture name will refuse rather than delete it\n');
  }

  return { dir: work, container, commits, branches: [branch], remote, suites: [...suites] };
}
