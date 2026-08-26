/**
 * Resolving what `bin/b7e-run <command>` should actually execute — the pure half; the
 * argv parsing, the spawn and the signal forwarding are `bin/b7e-run` itself.
 *
 * bc-dgx7.87, filed by the session audit against three sessions (bc-dgx7.80, bc-dgx7.77,
 * bc-dgx7.81) that each had to invoke a `b7e-*` command from inside their own worktree
 * and each worked out how differently — one lost four hours of wall clock gating the
 * MAIN checkout by mistake, one carried an absolute path as a shell variable through a
 * dozen consecutive Bash calls, one used a relative path that happened to work. The
 * root of all three is the same: `lib/foundation.js` puts the MAIN checkout's `bin/` on
 * every agent's `PATH` (see memory note `only-an-extensionless-bin-resolves-on-path`),
 * so typing a bare command name, or even `./bin/x`, does not reliably run the copy in
 * the worktree the session is actually sitting in — and nothing says so when it silently
 * doesn't.
 *
 * `repoRoot(cwd)` is the fix, and it is deliberately NOT the `path.join(HERE, '..')`
 * pattern several existing `b7e-*` commands use for their own default root (see memory
 * note `a-worktree-aware-bin-resolves-root-from-cwd-not-here`): `HERE` is always the
 * MAIN checkout's `lib/` directory, because `HERE` is derived from *this file's own*
 * path, and this file always executes from the main checkout's `bin/` regardless of
 * which worktree invoked it. Only `process.cwd()` reflects where the calling session
 * really is, so this shells `git rev-parse --show-toplevel` against it instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Used only when `cwd` is not inside any git worktree at all — this file's own checkout. */
const FALLBACK_ROOT = path.join(HERE, '..');

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return FALLBACK_ROOT;
  }
}

/** The file `b7e-run <command>` would execute for the given root — no extension guessing,
 * no package.json `bin` map lookup: exactly `<root>/bin/<command>`, the same file a shell
 * would run for `bin/<command>` typed from that root. */
export function targetFor(root, command) {
  return path.join(root, 'bin', command);
}

/** Where `command` would resolve on `pathEnv`, walking it the way a shell does — the
 * first directory holding a regular file of that name, or null. */
export function resolveOnPath(command, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/** A one-line warning when PATH would have run a *different* file than the one this is
 * about to run — null when PATH agrees, or does not resolve the name at all. `tree` is
 * the checkout that other copy belongs to (its `bin/`'s own parent), so the message names
 * what would have acted rather than just where. */
export function divergenceWarning(target, command, pathEnv = process.env.PATH || '') {
  const onPath = resolveOnPath(command, pathEnv);
  if (!onPath) return null;
  if (path.resolve(onPath) === path.resolve(target)) return null;
  const tree = path.dirname(path.dirname(onPath));
  return `b7e-run: PATH would instead have run ${onPath} (in ${tree})`;
}
