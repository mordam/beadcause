/**
 * Which of a workspace repo's own gate scripts actually read a given file — `bin/
 * b7e-covers` is the argv shell; this is the auditing, the cache and the matching.
 *
 * bc-dgx7.126: six sessions in the deluvia workspace (dv-afr.31, dv-52r.10, dv-5eu.21,
 * dv-5eu.20, dv-gr6.70, dv-gr6.69) each answered "does any gate cover the file I just
 * touched" by hand, with a `grep` over `scripts/`, before deciding what to run. No two
 * asked it the same way, two of the six concluded "nothing covers this" and then ran
 * every gate anyway because the grep answer was not trusted, and one (dv-gr6.70) took
 * five more calls to work out that `check_saga_audit.py` governs a brand-new interlude
 * file through a per-book *count* in an `INVENTORY` dict — nothing greppable ever
 * mentions the file's own name, and the gap only surfaced as a FAIL after the file was
 * already committed. `grep` cannot answer this; only actually running the gate can.
 *
 * ## Why an audit hook, not `grep`, not `sys.settrace`
 *
 * `lib/coversaudit.py` runs a check under `sys.addaudithook`, recording every path the
 * `open` event names (which `open()`, `io.open`, and every `pathlib.Path` read method
 * raise) and every directory an `os.listdir`/`os.scandir` event names (which `os.walk`
 * and `glob.glob` both funnel through in CPython, so a check that globs a directory is
 * indistinguishable here from one that lists it by hand). `sys.settrace` was the other
 * option the bead named; it fires on every line and call, which is both far slower and
 * gives nothing an audit hook does not already give for the two operations that matter
 * (a file name never has to be spelled out in the check's own source for a directory
 * walk to cover it, and a subprocess the check itself starts is out of scope for both
 * approaches equally — this only sees what the interpreter running the check does
 * directly).
 *
 * ## Filtered to the root being audited
 *
 * Every recorded path is normalised to absolute and then kept only if it falls under
 * the checkout root (`lib/coversaudit.py`'s own `under_root`) — otherwise every run
 * would carry the noise of whatever the interpreter itself opens before the check's
 * first line (stdlib source, `__pycache__`) and every check would spuriously "cover"
 * files nobody asked about.
 *
 * ## A gate that fails still contributes what it read
 *
 * `runpy.run_path` inside the wrapper catches `SystemExit` and any other exception,
 * records the exit code, and *always* writes the result — a check that raises on line
 * 40 still contributes whatever it opened or listed on lines 1-39. This is not an edge
 * case: it is the dv-gr6.70 shape verbatim, where the read that proves coverage
 * happens on the same run that then fails.
 *
 * ## Cached by the check script's own content hash
 *
 * `coverageForCheck` hashes the check's script file (sha256) and keeps the audit
 * result under `CACHE_DIR`, keyed by that hash — a rerun against an unchanged script
 * is a cache read, not a `python3` spawn, until the script itself is edited. This is
 * deliberately not keyed by anything about the *target* file being queried: the set of
 * directories and paths a check reads depends on the check's own control flow, not on
 * what currently happens to live in those directories, so a file created after the
 * cache was built is still covered by a directory-walk match without forcing a rerun.
 * `refresh: true` (`--refresh` on the CLI) ignores and overwrites a cache hit anyway.
 *
 * ## Matching: an ancestor directory still covers a file that does not exist yet
 *
 * `whichCover` reports `'opens it'` for an exact match in a check's recorded `reads`,
 * and `'walks its directory'` for any recorded directory that is an ancestor of the
 * query path — a file the check has never seen (because it was created after the
 * cache was built, or does not exist on disk at all yet) still matches through the
 * directory it would land in, which is the whole `INTERLUDE_035` case this bead is
 * named for. A check that both opens the exact file and lists its directory reports
 * only the more specific reason.
 *
 * ## Multiple query paths: matched-and-unmatched is all-or-nothing on stdout
 *
 * `bin/b7e-covers` follows `lib/affected.js`'s already-established rule for exactly
 * the same reason: a narrowed `--only` list is only safe to hand to `b7e-checks` when
 * *every* given path resolved to at least one gate — a partial list would silently
 * drop coverage for whichever path came back empty. One unmatched path anywhere in
 * the batch empties stdout for the whole call; each unmatched path still gets a loud
 * line on stderr, so an empty answer reads as "nothing found" rather than "nothing to
 * report".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIMEOUT_MS, discoverChecks, manifestFor } from './checks.js';
import { CONFIG_DIR } from './config.js';
import { defaultChangedFiles } from './affected.js';

export { discoverChecks, manifestFor, defaultChangedFiles };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The audit wrapper `auditCheck` spawns — never run directly, never on any allowlist. */
export const AUDIT_WRAPPER = path.join(HERE, 'coversaudit.py');

/** Where coverage results are cached, keyed by checkout root and check-script hash. */
export const CACHE_DIR = path.join(CONFIG_DIR, 'covers-cache');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** `CACHE_DIR/<root hash>/<check-name hash>.json` — one file per (root, check) pair. */
function cacheFile(root, check) {
  return path.join(CACHE_DIR, sha1(path.resolve(root)), `${sha1(check.name)}.json`);
}

/**
 * Runs one check under `lib/coversaudit.py`, returning `{ reads, dirs, exitCode }` —
 * absolute paths, filtered to `root`. Never throws: a check that cannot even start
 * (no `python3`, a syntax error before the audit hook installs) comes back with empty
 * `reads`/`dirs` and `exitCode: null` rather than failing the whole coverage map over
 * one bad script. `env`, if given, is merged over `process.env` the same way
 * `lib/checks.js`'s `runCheck` does — a check that shells out to `bd` needs the
 * target workspace's own `BEADS_DIR`, not whatever this process inherited.
 */
export function auditCheck(root, check, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  const [scriptRel, ...restArgv] = check.argv;
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'b7e-covers-'));
  const outPath = path.join(tmp, 'out.json');
  try {
    spawnSync('python3', [AUDIT_WRAPPER, outPath, scriptRel, ...restArgv], {
      cwd: root,
      timeout: timeoutMs || undefined,
      stdio: 'ignore',
      env: { ...process.env, ...(env || {}) },
    });
    try {
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      return { reads: parsed.reads || [], dirs: parsed.dirs || [], exitCode: parsed.exitCode ?? null };
    } catch {
      return { reads: [], dirs: [], exitCode: null };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * One check's coverage, cached by its script's own content hash. `refresh: true`
 * rebuilds regardless of what is cached; a cache entry whose hash no longer matches
 * the script on disk is rebuilt automatically either way.
 */
export function coverageForCheck(root, check, { refresh = false, timeoutMs, env } = {}) {
  const scriptAbs = path.join(root, check.argv[0]);
  let hash;
  try {
    hash = sha256File(scriptAbs);
  } catch {
    hash = null; // the check names a script that is not actually on disk — nothing to cache against
  }
  const file = cacheFile(root, check);
  if (!refresh && hash) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.hash === hash) return cached;
    } catch {
      /* no cache yet, or a corrupt entry — fall through and rebuild */
    }
  }
  const result = auditCheck(root, check, { timeoutMs, env });
  const entry = { name: check.name, hash, reads: result.reads, dirs: result.dirs, exitCode: result.exitCode };
  if (hash) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
  }
  return entry;
}

/** Every check `root`'s manifest finds, each with its (possibly cached) coverage. */
export function coverageMap(root, { refresh = false, timeoutMs, env } = {}) {
  return discoverChecks(root).map((check) => coverageForCheck(root, check, { refresh, timeoutMs, env }));
}

/**
 * Which checks in `map` cover `queryRel` (a path relative to `root`, or absolute), and
 * why. `'opens it'` beats `'walks its directory'` when a single check matches both
 * ways. Order follows `map`'s own order (a check's manifest order), not any ranking.
 */
export function whichCover(root, map, queryRel) {
  const abs = path.resolve(root, queryRel);
  const matches = [];
  for (const entry of map) {
    if (entry.reads.includes(abs)) {
      matches.push({ name: entry.name, reason: 'opens it' });
    } else if (entry.dirs.some((d) => abs === d || abs.startsWith(d + path.sep))) {
      matches.push({ name: entry.name, reason: 'walks its directory' });
    }
  }
  return matches;
}

/**
 * `queryRels` (repo-relative or absolute), each matched against `map`. Returns
 * `{ results, unmatched, names }` — `results` is one `{ path, matches }` per query in
 * order, `unmatched` the subset of `queryRels` with no match at all, `names` the
 * deduped union of every matched check's name across every query, in `map` order.
 */
export function coverAll(root, map, queryRels) {
  const results = queryRels.map((p) => ({ path: p, matches: whichCover(root, map, p) }));
  const unmatched = results.filter((r) => !r.matches.length).map((r) => r.path);
  const seen = new Set();
  const names = [];
  for (const { matches } of results) {
    for (const { name } of matches) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return { results, unmatched, names };
}
