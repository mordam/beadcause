/**
 * Prove a new check is red without the fix, and put the tree back — `bin/b7e-counterproof`
 * is the argv shell; this is the mutate/run/restore and the comparison underneath it.
 *
 * bc-68ou.14 names three sessions (bc-fh0sz, bc-xl7n.109, bc-gdub) that each wrote a
 * regression check, then had to answer "does this actually catch the bug?" — and each
 * built the answer by hand, differently: `git stash push -- <path> && node <suite>` then
 * `git stash pop`; the same stash with the pop chained onto a piped command, so the exit
 * code echoed was the pipe's, not the suite's; a `sed` mutation of a copy, run by hand,
 * three separate times for three separate lines; a `git checkout <ref> -- <paths>` that,
 * on the way back, ate an *uncommitted* edit the session then had to redo. Two of those
 * four forms leave the tree wrong if the suite crashes between mutate and restore, and one
 * of them actually lost work that way. This is the one answer: mutate the given paths to
 * an older ref, run the given suites, name exactly which checks turned red, then put the
 * paths back — the same however the process ends.
 *
 * ## The restore is `lib/teardown.js`'s, not a new one
 *
 * A `finally` covers a normal return and a thrown error. It does not cover a signal, and
 * a signal is the ordinary way this dies: a caller's own timeout, a `Ctrl-C`, an agent
 * harness stopping the run. `onExit` (bc-fh0sz) is the one mechanism in this repo proven
 * against exactly that — synchronous, runs on `exit` and on `SIGINT`/`SIGTERM`/`SIGHUP`,
 * and re-raises so the process still dies of the signal it was sent. Writing a second one
 * here would be the fourth hand-rolled restore this bead exists to replace.
 *
 * Every path named is snapshotted to raw bytes *before* anything is mutated — not read
 * through git, not assumed to match any ref — so an uncommitted edit at the moment this is
 * called is exactly what comes back, which is the case `bc-gdub` lost work to. `applyAt`
 * writes the new bytes on the same synchronous tick as the snapshot, with no `await`
 * between them: Node cannot run a signal handler in the middle of a run of synchronous
 * statements, so there is no window where a signal lands after the snapshot but before the
 * restore is armed.
 *
 * ## What "flipped" means
 *
 * Every suite is run *twice*: once against the tree exactly as it is (`baseline` — "with
 * the fix"), then again with the given paths reverted to `--at` (`after` — "without it").
 * A check is only counted as proven by the revert if it is green in `baseline` and red in
 * `after` — a check already red in `baseline` and still red in `after` is *not* proven by
 * this revert (it may be red for an unrelated reason, or flaking), and is reported
 * separately so it is not mistaken for evidence. This is the same by-name comparison
 * `lib/blame.js` makes between a local run and `origin/main`, pointed the other way: there
 * the question is "is this failure already on main", here it is "does this failure appear
 * only once the fix is gone".
 *
 * `extractChecks` is written fresh here rather than reusing `lib/blame.js`'s
 * `extractFailures`: that function returns only failing names, and this also needs the
 * total count (`X of Y flipped`) and the failure text under each `FAIL` line — the
 * "failure message the reverted code produced" the bead asks for. Both regexes follow the
 * same convention `lib/blame.js`'s own header documents (`test/systemcard.mjs` and
 * `scripts/selftest.mjs` both print `  ok   <name>` / `  FAIL <name>`, or a close variant
 * of that spacing), so a suite either tool can already blame or triage is a suite this can
 * already prove something about too.
 *
 * ## The lock is `b7e-gate`'s, not a new one
 *
 * `acquireLock` (`lib/gate.js`) is keyed only by the resolved root, so calling it here
 * takes the *same* lock a concurrent `b7e-gate` on this tree would hold — on purpose. This
 * command does everything a gate run does (spawns suites) and then some (mutates tracked
 * files while it runs them); letting a gate and a counterproof race on one tree is a worse
 * idea than either racing itself. Unlike `bin/b7e-gate`'s own use of this lock — which
 * calls only the `onExit`-returned disarm on its happy path, never `lock.release()` itself,
 * and so leaves its lock file behind every time it exits cleanly (harmless only because the
 * next `acquireLock` sees a dead pid and reclaims it as stale; filed as a small cleanup,
 * bc-dgx7.40) — this calls `lock.release()` directly on every path, normal or signalled,
 * the same two-call shape `scripts/helpers/chrome.mjs`'s `teardown` already uses for
 * exactly this reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, runSuite, timeoutMsFor, acquireLock } from './gate.js';
import { resolveSuite } from './triage.js';
import { candidateSuites, toRepoRel } from './affected.js';
import { onExit } from './teardown.js';

export { REPO_ROOT, toRepoRel };

/* ------------------------------------------------------------------------- the ref */

/**
 * `origin/main` if it resolves here, else `main`, else `null` — the same fallback
 * `lib/affected.js`'s own (private, unexported) `resolvableBase` uses, and for the same
 * reason: a fabricated test repo with no remote still has to resolve *something*.
 * Duplicated rather than imported because it is ten lines and private there; the same
 * trade this repo's own `check()` test helper makes 135 times over.
 */
function resolvableBase(root) {
  for (const cand of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', cand], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      return cand;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** `--at`'s default: the merge-base between here and whichever of the above resolves. */
export function resolveDefaultAt(root) {
  const base = resolvableBase(root);
  if (!base) return null;
  try {
    const out = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The bytes a path held at `ref`, or `null` if it did not exist there. Never text-decoded — a byte-exact restore needs byte-exact bytes. */
function readAtRef(root, ref, relPath) {
  try {
    // stderr explicitly piped (and dropped) rather than left to the execFileSync
    // default, which inherits it — a path this asks about routinely does not exist at
    // `ref` (that is what "revert a newly-added path" means), and git's own `fatal:` for
    // that is expected here, not something a caller should see leak past the `catch`.
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- mutate/restore */

/** The bytes every `relPaths` entry holds right now, `null` for one that does not exist. */
function snapshot(root, relPaths) {
  return relPaths.map((rel) => {
    const abs = path.join(root, rel);
    let before = null;
    try {
      before = fs.readFileSync(abs);
    } catch {
      before = null;
    }
    return { rel, abs, before };
  });
}

/** Puts every snapshotted path back exactly as `snapshot` found it — sync, so it is safe from inside an exit handler. */
function restoreSnapshot(entries) {
  for (const { abs, before } of entries) {
    if (before === null) {
      fs.rmSync(abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, before);
    }
  }
}

/** Overwrites every snapshotted path with its content at `ref` — removes it if `ref` never had it. */
function applyAt(root, ref, entries) {
  for (const { rel, abs } of entries) {
    const content = readAtRef(root, ref, rel);
    if (content === null) {
      fs.rmSync(abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

/* ------------------------------------------------------------------------- suite names */

/**
 * A caller may type `teardown`, `test/teardown.mjs` or `teardown.mjs` — `lib/triage.js`'s
 * `resolveSuite` only matches the exact string or an exact basename, so a bare stem with
 * no extension (the shape this bead's own acceptance criteria use) is tried again with
 * `.mjs` and `.js` appended before giving up. `allSuites` is `candidateSuites(root)`
 * (`lib/affected.js`) — `npm test`'s own list *union* every `scripts/*-check.mjs`, exactly
 * the "suites or scripts/*-check.mjs" the bead asks this to accept.
 */
export function resolveWork(name, allSuites) {
  for (const candidate of [name, `${name}.mjs`, `${name}.js`]) {
    const { suite } = resolveSuite(candidate, allSuites);
    if (suite) return { suite, reason: null };
  }
  return resolveSuite(name, allSuites);
}

/* ------------------------------------------------------------------------- extraction */

const FAIL_LINE_RE = /^\s*FAIL\b\s*[-:]?\s*(.+)$/;
const OK_LINE_RE = /^\s*ok\b\s*[-:]?\s*(.+)$/;

/**
 * Every named check line in a suite's combined stdout+stderr, in the order printed —
 * `{ kind: 'ok', name }` or `{ kind: 'fail', name, detail }`, `detail` being the indented
 * lines a `FAIL` is immediately followed by (this repo's `check()` helpers print the
 * thrown message there), joined with newlines and stopped at the next named line or the
 * next blank one. A suite that names nothing this way — no `FAIL`/`ok` line at all —
 * returns `[]`, same as `lib/blame.js`'s `extractFailures` on the same input: nothing to
 * compare by name, not zero checks.
 */
export function extractChecks(output) {
  const lines = String(output || '').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const failMatch = FAIL_LINE_RE.exec(lines[i]);
    if (failMatch) {
      const name = failMatch[1].trim();
      if (!name) continue;
      const detail = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim() || OK_LINE_RE.test(line) || FAIL_LINE_RE.test(line)) break;
        detail.push(line.trim());
      }
      rows.push({ kind: 'fail', name, detail: detail.join('\n') });
      continue;
    }
    const okMatch = OK_LINE_RE.exec(lines[i]);
    if (okMatch) {
      const name = okMatch[1].trim();
      if (name) rows.push({ kind: 'ok', name });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------------- the counterproof */

/**
 * Reverts `paths` to `at` (default `resolveDefaultAt(root)`), runs every entry in
 * `suites` against the tree both before and after, and says which named checks are green
 * before and red after — proven by the revert — versus red both times (not proven; may be
 * unrelated or flaky) — then always puts `paths` back, however the run ends.
 *
 * A suite name that does not resolve against `candidateSuites(root)` is a refusal (nothing
 * is ever mutated) unless `keepGoing` is set, in which case it is dropped and the rest of
 * the named suites still run — `bc-68ou.14`'s own text for `--keep-going` is truncated in
 * the tracker ("run every named suite rather than stopping at the—"); this is the reading
 * taken, documented so a later session does not have to guess again: keep going *past a
 * suite that cannot be found*, not past a suite that runs but proves nothing.
 *
 * Returns `{ ok: false, refusal }` for a usage problem — a bad `--at`, no paths, no
 * suites, nothing resolvable, or the lock already held. Otherwise
 * `{ ok: true, at, suites: [{ input, suite, total, flipped, alreadyRed, status }],
 * unresolved, totalFlipped, totalChecked, proven }` — `proven` is true only when every
 * runnable suite had at least one flip; a suite that passes both ways proves nothing, and
 * the bead is explicit that this is a failure of the run, not a quiet 0.
 */
export async function counterprove(root, { at, paths = [], suites = [], timeoutOverrideMs, keepGoing = false } = {}) {
  // Cheapest checks first — neither needs git, so neither should have to wait on a
  // `--at` that will turn out not to matter.
  if (!paths.length) return { ok: false, refusal: 'no paths given to revert' };
  if (!suites.length) return { ok: false, refusal: 'no suites given to run' };

  const resolvedAt = at || resolveDefaultAt(root);
  if (!resolvedAt) {
    return { ok: false, refusal: 'could not resolve a default --at (no origin/main or main here) — pass one explicitly' };
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', `${resolvedAt}^{commit}`], { cwd: root, stdio: 'pipe' });
  } catch {
    return { ok: false, refusal: `--at ${resolvedAt} does not resolve to a commit in ${root}` };
  }

  const all = candidateSuites(root);
  const resolved = suites.map((input) => ({ input, ...resolveWork(input, all) }));
  const unresolved = resolved.filter((r) => !r.suite);
  if (unresolved.length && !keepGoing) {
    return { ok: false, refusal: unresolved.map((r) => `${r.input}: ${r.reason}`).join('; '), at: resolvedAt };
  }
  const runnable = resolved.filter((r) => r.suite);
  if (!runnable.length) {
    return { ok: false, refusal: 'no suite named resolved to anything runnable', at: resolvedAt };
  }

  const lock = acquireLock(root);
  if (!lock.ok) {
    const since = lock.startedAt ? `${Math.round((Date.now() - lock.startedAt) / 1000)}s ago` : 'a while ago';
    return { ok: false, refusal: `a gate or counterproof is already running on this tree — pid ${lock.pid}, started ${since}` };
  }
  const disarmLock = onExit(lock.release);

  const live = new Set();
  const killLive = () => {
    for (const child of live) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  const disarmKill = onExit(killLive);

  let entries = null;
  let disarmRestore = null;
  const suiteReports = [];
  try {
    const baseline = new Map();
    for (const r of runnable) {
      const timeoutMs = timeoutMsFor(r.suite, timeoutOverrideMs);
      const run = await runSuite(root, r.suite, { timeoutMs, live });
      baseline.set(r.suite, extractChecks(run.out));
    }

    // Snapshot, arm the restore, and mutate — all on the same synchronous tick, no
    // `await` between any of them, so no signal can land in a window where the paths are
    // mutated but the restore is not yet armed. See the header.
    entries = snapshot(root, paths);
    disarmRestore = onExit(() => restoreSnapshot(entries));
    applyAt(root, resolvedAt, entries);

    for (const r of runnable) {
      const timeoutMs = timeoutMsFor(r.suite, timeoutOverrideMs);
      const run = await runSuite(root, r.suite, { timeoutMs, live });
      const after = extractChecks(run.out);
      const baseFailNames = new Set(baseline.get(r.suite).filter((c) => c.kind === 'fail').map((c) => c.name));
      const afterFails = after.filter((c) => c.kind === 'fail');
      suiteReports.push({
        input: r.input,
        suite: r.suite,
        status: run.status,
        total: after.length,
        flipped: afterFails.filter((c) => !baseFailNames.has(c.name)),
        alreadyRed: afterFails.filter((c) => baseFailNames.has(c.name)),
      });
    }
  } finally {
    disarmKill();
    killLive();
    if (disarmRestore) disarmRestore();
    if (entries) restoreSnapshot(entries);
    disarmLock();
    lock.release();
  }

  const totalFlipped = suiteReports.reduce((n, s) => n + s.flipped.length, 0);
  const totalChecked = suiteReports.reduce((n, s) => n + s.total, 0);
  const proven = suiteReports.length > 0 && suiteReports.every((s) => s.flipped.length > 0);

  return { ok: true, at: resolvedAt, suites: suiteReports, unresolved, totalFlipped, totalChecked, proven };
}

/** `0` every runnable suite flipped at least one check; `1` ran fine but at least one did not (or a named suite was skipped, unresolved, under `--keep-going`); `2` refused outright. */
export function exitCodeFor(result) {
  if (!result.ok) return 2;
  if (result.unresolved.length) return 1;
  return result.proven ? 0 : 1;
}

/** The printed report — one block per suite, then the overall tally line. */
export function reportLines(result) {
  if (!result.ok) return [`refused — ${result.refusal}`];
  const lines = [`reverted against ${result.at}`];
  for (const s of result.suites) {
    lines.push('', `${s.suite}${s.input === s.suite ? '' : ` (${s.input})`}`);
    if (!s.flipped.length) {
      lines.push(`  0 of ${s.total} flipped — passes both ways, proves nothing`);
    } else {
      lines.push(`  ${s.flipped.length} of ${s.total} flipped:`);
      for (const c of s.flipped) {
        lines.push(`    FAIL ${c.name}`);
        if (c.detail) for (const d of c.detail.split('\n')) lines.push(`         ${d}`);
      }
    }
    if (s.alreadyRed.length) {
      lines.push(`  already red before the revert too, not proven by it: ${s.alreadyRed.map((c) => c.name).join(', ')}`);
    }
  }
  for (const u of result.unresolved) lines.push('', `${u.input}: unresolved — ${u.reason}`);
  lines.push('', `${result.totalFlipped} of ${result.totalChecked} flipped`);
  return lines;
}
