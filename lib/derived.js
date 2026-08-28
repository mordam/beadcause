/**
 * What in a checkout is generated from a source file, and whether it is now stale —
 * `bin/b7e-derived` is the argv shell; this is the mapping and the running.
 *
 * bc-dgx7.1's session audit found the same question asked five times by hand in deluvia
 * (`dv-afr.18`, `dv-5eu.18`, `dv-5eu.17`, `dv-afr.17`, `dv-5eu.19`) — "what does this repo
 * regenerate from the file I just edited, and did I keep it in step?" — answered each time
 * with a different ad-hoc `grep` or, in `dv-5eu.19`'s case, not until a gate went red over a
 * word count six edits later. `lib/affected.js` already answers the sibling question ("what
 * *tests* this file") the same way this answers "what does this file *feed*": read a small
 * declaration, match a changed path against it, run what the repo itself already runs.
 *
 * ## The declaration lives in the checkout, not in this repo
 *
 * `lib/repoviews.js` already makes this argument for a different declaration
 * (`.beadcause/views.json`): a fact about which scripts a checkout runs and which files
 * they touch is a fact about that checkout, at that revision, and it moves with the commit
 * that changes it. Hardcoding deluvia's generator paths into *this* repo would mean this
 * repo needs a pull request every time deluvia renames `compendium/build.py`, and would
 * give every other workspace — sophab, ehatt — nothing at all until somebody wrote a
 * second hardcoded table for each of them. `.beadcause/derived.json` (`MANIFEST_FILE`
 * below) is that declaration, one file, read the same way `views.json` is: never trusted
 * beyond "a fact this checkout asserts about itself", and its `run`/`check` commands are as
 * trusted as everything else this daemon already runs in that checkout — the gate, the
 * deploy script, the view generators.
 *
 *     {
 *       "generators": [
 *         {
 *           "id": "compendium/build.py",
 *           "run": ["python3", "compendium/build.py"],
 *           "check": ["python3", "compendium/build.py", "--check"],
 *           "sources": ["compendium/**"],
 *           "artifacts": [
 *             "compendium/web/data.js",
 *             "reference/maps/private/compendium.admin.js",
 *             "reference/maps/private/compendium.reader.js"
 *           ]
 *         }
 *       ]
 *     }
 *
 * `run` is an argv, never a shell string — same reasoning as `lib/repoviews.js`'s
 * `runGenerator`: a filename with a space in it stays a filename with a space in it, and a
 * manifest cannot smuggle `; rm -rf` through one. `check` is optional; a generator with none
 * is still matched and listed, just never reported clean or stale.
 *
 * ## Two small pieces of matching, not one big one
 *
 * `matchesSource` turns each `sources` glob into a regex once (`*` inside a path segment,
 * `**` across segments, everything else literal) and tests it against a changed,
 * repo-relative path. `findDerived` is the whole answer for one list of changed files and
 * one list of generators — pure, no filesystem, no subprocess — which is what makes it
 * testable against a handful of literal strings and, separately, testable end to end
 * against a `.beadcause/derived.json` fixture through `--dir` the same way
 * `test/affected.mjs` drives `lib/affected.js` against a fabricated tree.
 *
 * `runCheck`/`runRebuild` are the only functions that touch a subprocess, and both take an
 * explicit `root` to run in and a timeout, so a generator that hangs cannot hang this
 * command with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This repo's own root — same anchor `lib/affected.js`'s `REPO_ROOT` uses. */
export const REPO_ROOT = path.join(HERE, '..');

/** The one directory in a checkout this reads, same convention as `lib/repoviews.js`. */
export const MANIFEST_DIR = '.beadcause';
/** The manifest inside it. */
export const MANIFEST_FILE = 'derived.json';

/** How long a `run`/`check` may take before it is killed and reported as trouble. */
export const RUN_TIMEOUT_MS = 60_000;
/** How much stdout/stderr a `run`/`check` may produce. */
export const RUN_MAX_BYTES = 8 * 1024 * 1024;

/* -------------------------------------------------------------------------- the manifest */

/**
 * `<root>/.beadcause/derived.json`, read and validated. Returns
 * `{ generators: [{ id, sources, artifacts, run, check }], problems: [string, ...] }`.
 *
 * Never throws. No manifest at all is `{ generators: [], problems: [] }` — a checkout with
 * nothing generated looks exactly like one nobody has declared yet, which is the right
 * answer for both. A manifest that exists but cannot be read or parsed is reported as a
 * problem rather than silently treated as empty, the same distinction `lib/repoviews.js`
 * draws for `views.json` and `lib/affected.js`'s header calls "never a shrug": a checkout
 * that meant to declare something and got the JSON wrong should not read as "nothing here".
 *
 * A malformed *entry* (no `id`, no `sources`, no `artifacts`) is dropped and reported by
 * itself; one bad generator does not take the rest of the manifest down with it, the same
 * choice `lib/repoviews.js` makes for one bad view.
 */
export function loadManifest(root) {
  const file = path.join(root, MANIFEST_DIR, MANIFEST_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { generators: [], problems: [] };
    return { generators: [], problems: [`cannot read ${MANIFEST_DIR}/${MANIFEST_FILE} — ${err.message.split('\n')[0]}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { generators: [], problems: [`${MANIFEST_DIR}/${MANIFEST_FILE} does not parse as JSON — ${err.message.split('\n')[0]}`] };
  }
  const list = Array.isArray(parsed?.generators) ? parsed.generators : [];
  const generators = [];
  const problems = [];
  const strArray = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
  list.forEach((g, i) => {
    const where = `${MANIFEST_DIR}/${MANIFEST_FILE} generators[${i}]`;
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      problems.push(`${where} is not an object`);
      return;
    }
    const id = typeof g.id === 'string' && g.id.trim() ? g.id.trim() : null;
    if (!id) {
      problems.push(`${where} has no id`);
      return;
    }
    const sources = strArray(g.sources);
    if (!sources.length) {
      problems.push(`${where} (${id}) names no sources`);
      return;
    }
    const artifacts = strArray(g.artifacts);
    if (!artifacts.length) {
      problems.push(`${where} (${id}) names no artifacts`);
      return;
    }
    const run = strArray(g.run);
    const check = strArray(g.check);
    generators.push({ id, sources, artifacts, run: run.length ? run : null, check: check.length ? check : null });
  });
  return { generators, problems };
}

/* -------------------------------------------------------------------------- glob matching */

const escapeLiteral = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * A `sources` glob turned into a regex, once per pattern (cached below). Three tokens:
 * `**` crosses `/`, a lone `*` stops at it, everything else is literal. `**​/` collapses to
 * "zero or more path segments" so `novel/**​/CHAPTER_*.md` matches
 * `novel/Deluvia Book 3/CHAPTER_12.md` *and* a chapter file sitting directly under `novel/`.
 */
export function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') {
        re += '(?:.*/)?';
        i += 1;
      } else {
        re += '.*';
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    re += escapeLiteral(c);
    i += 1;
  }
  re += '$';
  return new RegExp(re);
}

const reCache = new Map();
const compiled = (glob) => {
  if (!reCache.has(glob)) reCache.set(glob, globToRegExp(glob));
  return reCache.get(glob);
};

/** Does any of `generator.sources` match this repo-relative path? */
export function matchesSource(generator, relFile) {
  return generator.sources.some((pat) => compiled(pat).test(relFile));
}

/* ------------------------------------------------------------------------------ matching */

/**
 * The whole answer for one list of changed (repo-relative) files against one list of
 * generators: `{ results: [{ file, generators: [generator, ...] }], unmatched: [file, ...],
 * generators: [generator, ...] }`.
 *
 * `results` only carries files with at least one match; a file with none is in `unmatched`
 * instead, never silently absent from both — same "never a shrug" rule `lib/affected.js`
 * states for its own sibling question. `generators` on the return is the deduplicated set
 * actually touched, in first-seen order, which is what `--check`/`--rebuild` iterate.
 */
export function findDerived(changedFiles, generators) {
  const results = [];
  const unmatched = [];
  const touchedIds = new Set();
  const touched = [];
  for (const file of changedFiles) {
    const matches = generators.filter((g) => matchesSource(g, file));
    if (matches.length) {
      results.push({ file, generators: matches });
      for (const g of matches) {
        if (!touchedIds.has(g.id)) {
          touchedIds.add(g.id);
          touched.push(g);
        }
      }
    } else {
      unmatched.push(file);
    }
  }
  return { results, unmatched, generators: touched };
}

/* ------------------------------------------------------------------------------ running */

/** Spawn one argv in `root`. Returns `{ ok, code, tail }` — never throws. */
function runArgv(root, argv, timeoutMs) {
  const [cmd, ...args] = argv;
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: RUN_MAX_BYTES,
      encoding: 'utf8',
      // Never a shell — see the header note above and lib/repoviews.js's own comment on
      // `runGenerator`: an argv is what makes a filename with a space in it stay one.
      shell: false,
    });
    return { ok: true, code: 0, tail: String(stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400) };
  } catch (err) {
    const stderrTail = String(err.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    const why = err.signal === 'SIGTERM' && err.killed ? `timed out after ${timeoutMs / 1000}s` : err.message.split('\n')[0];
    return { ok: false, code: typeof err.status === 'number' ? err.status : null, tail: stderrTail || why };
  }
}

/**
 * Run a generator's own `check` argv in `root`. `{ status: 'clean' | 'stale' | 'no-check',
 * detail }`. Convention (`build_series_log.py . --check` and siblings): exit `0` is clean,
 * any other exit is stale, and the last few lines of output are why.
 */
export function runCheck(root, generator, timeoutMs = RUN_TIMEOUT_MS) {
  if (!generator.check) return { status: 'no-check', detail: `${generator.id} declares no check command` };
  const { ok, tail } = runArgv(root, generator.check, timeoutMs);
  return { status: ok ? 'clean' : 'stale', detail: tail };
}

/**
 * Run a generator's own `run` argv in `root` — this is the one thing in this file that
 * writes to the checkout. `{ status: 'ran' | 'no-run' | 'failed', detail }`.
 */
export function runRebuild(root, generator, timeoutMs = RUN_TIMEOUT_MS) {
  if (!generator.run) return { status: 'no-run', detail: `${generator.id} declares no run command` };
  const { ok, tail } = runArgv(root, generator.run, timeoutMs);
  return { status: ok ? 'ran' : 'failed', detail: tail };
}
