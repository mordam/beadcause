/**
 * The record `b7e-gate` writes as it runs, and what `b7e-watch` makes of it.
 *
 * bc-gdub.3 is the session audit that found the same twenty minutes spent by hand in
 * six sessions: launch the full suite in the background, then poll it — `tail -1
 * sweep.log`, `grep -c 'ok\|FAIL' gate.log`, `ps -o etime=` — thirty-odd times in a
 * row, each session's own spelling, one of them defeated outright by the runner's own
 * ANSI colour codes. There was nowhere to ask the question except the log, because
 * nothing wrote the answer down in a shape a program could read. This is that shape:
 * one JSONL file per gate run, a `start` line, one `result` line per suite as it
 * finishes, an `end` line when the run is over. A reader only ever parses these
 * lines — colour codes in whatever a suite printed to its own stdout cannot change
 * the answer, because nothing here greps a log.
 *
 * `bin/b7e-gate` (bc-khoe.39, landed first) is the writer, wired through its own
 * `onResult` callback; `bin/b7e-watch` is the reader. Whether a red suite is already
 * red on `origin/main` is deliberately not this file's job — `lib/blame.js`
 * (`bin/b7e-blame`, bc-khoe.42) already runs exactly that comparison, by named check
 * rather than by exit code, with its own tested worktree-and-timeout handling; a
 * second implementation here would be the "three separately-built control sets"
 * mistake the epic (bc-dgx7) exists to avoid repeating. `bin/b7e-watch` calls
 * `runBlame` directly for whichever suites are still red.
 *
 * Runs live at `<mainCheckout>/.claude/gate-runs`, deliberately outside every
 * worktree's own working tree — inside one, `git add -A` at delivery time would sweep
 * a live run's own JSONL file onto whichever branch happened to be open (see the
 * `gate-config-dir-must-be-outside-the-worktree` memory note this shape is built to
 * avoid repeating). Two worktrees, two sessions, therefore see the same directory: a
 * run started in one is readable from any other by `--run <id>`.
 *
 * Not registered in `lib/evidence.js`: these are churn, gone with the worktree they
 * describe, the same shape as `logs/` and `workers/` under `~/.config/beadcause` —
 * and they never touch `CONFIG_DIR` or a `refs/beadcause/*` ref, which is the only
 * thing `test/evidence.mjs` actually watches for.
 *
 * `startRun` also stamps the tree it is about to test — `sha` (`HEAD`), `tree` (a
 * snapshot of every tracked file's on-disk content, `HEAD` included) and `untracked`
 * (`{ path: blobHash }` for every file git does not track yet) — and `compareToTree`
 * below is
 * what `bin/b7e-gated` (`bc-dgx7.39`) calls to ask whether that snapshot still matches
 * the tree in front of the caller. That is the question `b7e-watch` never answered:
 * `bc-xl7n.108` started a gate at suite 62/416, made three more edits while it ran,
 * and delivered "all 416 passed" on a run that had never seen them; `bc-4r10.20` and
 * `bc-4r10.3.2` did the same with README and a broken `node_modules`. `bc-xl7n.110`
 * caught its own case only by remembering the edit — this makes that answerable
 * instead of remembered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, gitInput, ok, mainCheckout } from './gitref.js';

/** `<mainCheckout>/.claude/gate-runs`, created on first write. */
export async function runsDir(cwd) {
  const main = await mainCheckout(cwd);
  return path.join(main, '.claude', 'gate-runs');
}

/**
 * `worktree-b7e-watch-gdub3`, or `main` for the main checkout itself — the slug a run
 * is filed under, so "this worktree's most recent run" is a filename prefix and never
 * a scan of every run's contents.
 */
export async function worktreeSlug(cwd) {
  const main = await mainCheckout(cwd);
  const real = fs.realpathSync(path.resolve(cwd));
  const mainReal = fs.realpathSync(main);
  if (real === mainReal) return 'main';
  const rel = path.relative(mainReal, real);
  const parts = rel.split(path.sep);
  // `.claude/worktrees/<name>/...` — every worktree in this repo lives there.
  const i = parts.indexOf('worktrees');
  if (i > -1 && parts[i - 1] === '.claude' && parts[i + 1]) return parts[i + 1];
  return 'main';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/**
 * Millisecond resolution, not just seconds — a run id also decides sort order
 * (`listRunFiles` sorts by filename, newest first), and two runs of a fast suite
 * started back to back can land in the same second.
 */
function stamp(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}Z`;
}

/** A run id is also its filename stem: `<worktree>-<timestamp>-<rand>`. */
function newRunId(slug) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${stamp()}-${rand}`;
}

/**
 * A run id is a filename, so anything that could leave the runs directory — a separator,
 * a `..`, a NUL — is refused rather than resolved. `startRun` is the only caller that can
 * ever be handed one from outside (`b7e-gate --run-id`, which `bin/b7e-detach` uses to
 * know the answer before the child it spawns has done anything), and refusing here is
 * what keeps that flag from being a path.
 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The id `startRun` *would* mint for a run in `cwd`, minted now — for a caller that has
 * to say the id before the run exists. `bin/b7e-detach` (bc-dgx7.25) is that caller: it
 * detaches `b7e-gate` into a session of its own and must hand its own caller a run id in
 * the same breath, without reading the child's log back to find out what the child chose.
 * Exported rather than reimplemented there, so both spellings of a run id stay one
 * spelling and a detached run sorts in `listRunFiles` alongside every other.
 */
export async function mintRunId(cwd) {
  return newRunId(await worktreeSlug(cwd));
}

function fileFor(dir, runId) {
  return path.join(dir, `${runId}.jsonl`);
}
export function runFile(dir, runId) {
  return fileFor(dir, runId);
}

/**
 * A single commit-ish object standing for every TRACKED file's content on disk right
 * now, staged or not — without touching the index, the working tree or any ref.
 * `git stash create` computes exactly this as a throwaway commit and prints its sha;
 * unlike `git stash push`/`save` it never writes `refs/stash`, which on this repo's
 * own worktree layout is shared across every worktree of the same checkout (the
 * `a-dead-attempts-work-is-uncommitted-in-its-worktree` kind of trap this sidesteps
 * on purpose). When the working tree already matches `HEAD` exactly, `stash create`
 * has nothing to snapshot and prints nothing — `HEAD`'s own sha stands in, since that
 * is what the tree equals.
 */
async function snapshotTree(cwd) {
  const created = ((await ok(git(cwd, ['stash', 'create']))) || '').trim();
  if (created) return created;
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

/** The tree the index would produce if committed right now — a plumbing read only. */
async function snapshotIndexTree(cwd) {
  return (await git(cwd, ['write-tree'])).trim();
}

/**
 * `{ path: blobSha }` for what `treeish` holds at each of `files` — `''` for a path it
 * holds nothing at, which is an ordinary answer here rather than an error: it is what a
 * deleted file, or a file that was never in that tree at all, looks like. The shas are
 * the same content-address `untrackedHashes` computes off the disk, which is what makes
 * the two directly comparable across the tracked/untracked line (bc-dgx7.49).
 *
 * One `git cat-file --batch-check` for the whole list rather than a `rev-parse` each, for
 * the same reason `untrackedHashes` batches: the list is every file that crossed that
 * line since the run started, and a worktree that has grown a scratch directory since
 * then hands this dozens of paths. `--batch-check` answers in input order and prints
 * `<rev> missing` for what it cannot resolve, so a missing path costs a line, not a
 * non-zero exit.
 */
async function blobsAt(cwd, treeish, files) {
  const out = {};
  if (!treeish || !files.length) return out;
  const input = files.map((f) => `${treeish}:${f}`).join('\n') + '\n';
  const res = await ok(gitInput(cwd, ['cat-file', '--batch-check=%(objectname)'], input));
  const lines = (res || '').split('\n');
  files.forEach((f, i) => {
    const line = (lines[i] || '').trim();
    out[f] = line && !/\smissing$/.test(line) ? line : '';
  });
  return out;
}

/** Every file git does not track yet, sorted — `stash create` above never sees these. */
async function untrackedFiles(cwd) {
  const out = (await ok(git(cwd, ['ls-files', '--others', '--exclude-standard']))) || '';
  return out.split('\n').filter(Boolean).sort();
}

/**
 * `{ path: blobHash }` for every untracked file — the same content-address `git add`
 * would give each one, computed with `git hash-object --stdin-paths` (one process, one
 * hash per line, same order as the paths fed in) rather than one call per file. Never
 * writes an object to the store (no `-w`): the hash alone is enough to compare two
 * points in time, because it IS the content.
 *
 * By hash rather than by name: `startRun` can run against a tree that already has an
 * untracked file sitting in it, and the ordinary next step after a `b7e-gate` run this
 * command is meant to validate is committing exactly that — `git add` turns an
 * untracked path into a tracked one with the SAME bytes. Comparing by name alone would
 * read every such commit as "the tree moved" purely because the path left the
 * untracked list, which is not a content change and not the drift this tool exists to
 * catch (bc-dgx7.39 dogfooded this on its own delivery: committing `bin/b7e-gated`
 * itself, untouched since the gate ran, still read as moved under a by-name compare).
 * A hash here is only half of that, though — recording one does not stop the *tracked*
 * diff naming the same path once it is added, which is what it did until bc-dgx7.49; see
 * `compareToTree` for the reconciliation that spends this hash to cancel it out.
 */
async function untrackedHashes(cwd) {
  const files = await untrackedFiles(cwd);
  if (!files.length) return {};
  const out = await ok(gitInput(cwd, ['hash-object', '--stdin-paths'], files.join('\n') + '\n'));
  const hashes = (out || '').trim().split('\n');
  const map = {};
  files.forEach((f, i) => {
    if (hashes[i]) map[f] = hashes[i];
  });
  return map;
}

/**
 * Starts a run: picks an id, writes the `start` line, returns `{ runId, file }` for
 * the caller to pass to `appendResult`/`endRun`. Throws if `cwd` is not inside a git
 * checkout — a caller running against a fabricated, non-git test tree (`b7e-gate
 * --dir <scratch>` in `test/gate.mjs`) is expected to catch that and record nothing,
 * rather than this function guessing at a location to write to.
 */
export async function startRun(cwd, { suites, label, runId: givenId } = {}) {
  if (givenId != null && !RUN_ID_RE.test(givenId)) {
    throw new Error(`not a usable run id: ${givenId}`);
  }
  const dir = await runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const slug = await worktreeSlug(cwd);
  // Given one (`b7e-gate --run-id`, from `bin/b7e-detach`) it is used as-is, so the id a
  // caller was handed before the fork is the id the record is actually filed under.
  const runId = givenId || newRunId(slug);
  const file = fileFor(dir, runId);
  const branch = ((await ok(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))) || '').trim();
  const sha = ((await ok(git(cwd, ['rev-parse', 'HEAD']))) || '').trim() || undefined;
  // Best-effort, same as `sha` above: a `--dir` fixture with no `origin` remote at all
  // (most of `test/gate.mjs`'s own CLI checks) has nothing to compute this against, and
  // that must not be why a run record fails to start. `bin/b7e-stillred` (bc-dgx7.62) is
  // the reader this exists for — it needs the merge-base as it stood *when the run was
  // taken*, not whatever `origin/main` has moved on to by the time someone asks, so this
  // is computed here rather than left for a reader to derive from `sha` alone later.
  const mergeBase = ((await ok(git(cwd, ['merge-base', 'HEAD', 'origin/main']))) || '').trim() || undefined;
  const tree = await snapshotTree(cwd);
  const untracked = await untrackedHashes(cwd);
  const line = {
    type: 'start',
    runId,
    at: new Date().toISOString(),
    total: suites.length,
    suites,
    worktree: slug,
    cwd: path.resolve(cwd),
    branch,
    sha,
    mergeBase,
    tree,
    untracked,
    label: label || undefined,
  };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  return { runId, file };
}

/** One suite's result, appended as it finishes. `status` is `'ok'` or `'fail'`. */
export function appendResult(file, { suite, status, elapsed, tail }) {
  const line = { type: 'result', suite, status, elapsed, at: new Date().toISOString() };
  if (tail) line.tail = tail;
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

/** Closes the run out. `status` is `'ok'` if nothing failed, else `'fail'`. */
export function endRun(file, { status, elapsed }) {
  const line = { type: 'end', at: new Date().toISOString(), status, elapsed };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

/**
 * Every run file in the directory, newest first by the timestamp in its own name —
 * not by mtime, which an `rsync` or a restored backup can leave meaning nothing.
 */
export function listRunFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f));
}

/**
 * Parses one run file into a summary. Never throws on a malformed line — a run file
 * read while its writer is mid-`appendFileSync` can end in a torn last line, and
 * that is "still running", not a reason to blow up the caller.
 */
export function readRun(file) {
  const runId = path.basename(file, '.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let start = null;
  let end = null;
  const bySuite = new Map(); // last result wins, in case a suite is ever re-run within one file
  for (const l of lines) {
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      continue; // torn line — the writer was mid-append
    }
    if (obj.type === 'start') start = obj;
    else if (obj.type === 'end') end = obj;
    else if (obj.type === 'result' && obj.suite) bySuite.set(obj.suite, obj);
  }
  const results = [...bySuite.values()];
  const failed = results.filter((r) => r.status === 'fail');
  const startedAt = start ? Date.parse(start.at) : NaN;
  const now = end ? Date.parse(end.at) : Date.now();
  return {
    runId,
    file,
    running: !end,
    total: start ? start.total : null,
    // The full selected list from the `start` line — `missingFrom` below diffs this
    // against `results` to find suites that never produced a line at all, which `done`/
    // `failed` (built from `results` alone) cannot see.
    suites: start ? start.suites || null : null,
    // One entry per suite that got a `result` line, in the shape `appendResult` wrote it
    // (`{suite, status, elapsed, at, tail}`) — `resultsFor`/`missingFrom` below read this
    // rather than re-parsing the file a second time.
    results,
    done: results.length,
    failed: failed.map((f) => f.suite),
    worktree: start ? start.worktree : null,
    branch: start ? start.branch : null,
    cwd: start ? start.cwd || null : null,
    // `sha`/`tree`/`untracked` are absent on a run written before bc-dgx7.39 (or one
    // recorded against a fabricated non-git `--dir`) — `compareToTree` below treats a
    // missing `tree` as "nothing to compare against" rather than a crash. `mergeBase` is
    // absent on a run written before bc-dgx7.62, or one recorded against a `--dir` with
    // no `origin` remote at all — `bin/b7e-stillred` treats a missing `mergeBase` the
    // same way, recomputing it against whatever `origin/main` is right now rather than
    // refusing to answer.
    sha: start ? start.sha || null : null,
    mergeBase: start ? start.mergeBase || null : null,
    tree: start ? start.tree || null : null,
    untracked: start ? start.untracked || {} : {},
    startedAt: start ? start.at : null,
    endedAt: end ? end.at : null,
    elapsedSeconds: Number.isFinite(startedAt) ? Math.round((now - startedAt) / 1000) : null,
    status: end ? end.status : 'running',
  };
}

/**
 * Does `run`'s own recorded tree still match the tree it was actually run against,
 * right now? The question `bin/b7e-gated` exists to answer — see the file header for
 * why nothing before this bead could ask it.
 *
 * The directory compared against is `run.cwd` — the same directory `startRun` snapshot
 * when the run began, recorded in every `start` line since this file existed, **not**
 * whatever directory the caller of this function happens to be sitting in. That
 * matters because `--run <id>` (both `b7e-watch` and `b7e-gated`) is meant to read a
 * run started by a different session in a different worktree; comparing that run's
 * baseline against the CALLER's own working tree would compare two unrelated
 * checkouts (different branch, different files) and misreport every cross-worktree
 * lookup as maximally "moved". Pass `cwd` in `opts` only to override this, which tests
 * do to point at a fixture directly.
 *
 * `matches` is `true`/`false`/`null` — `null` when there is nothing to compare against
 * (a pre-bc-dgx7.39 run, a run whose own directory no longer exists, or a `--dir` this
 * couldn't snapshot at all), which a caller should treat as "cannot confirm the verdict
 * still applies", not as a pass. `changed` names every file responsible for a `false`:
 * tracked files via `git diff --name-only` between the two snapshot commits, plus any
 * untracked file (`git stash create` never sees these either way) whose *content hash*
 * differs from what it was, is now missing, or is new — compared by hash rather than by
 * name so an untracked file edited while it STAYS untracked is caught too, which a
 * by-name-only comparison would silently miss.
 *
 * A FILE THAT CROSSES THE TRACKED/UNTRACKED LINE without its bytes changing is not
 * drift, and bc-dgx7.49 is what made that true. A file untracked when the run started
 * and later `git add`ed — the ordinary next step right after the gate run this command
 * exists to validate — used to read as moved: `run.tree` is built from tracked content
 * only (`git stash create` cannot see an untracked file at all), so that path is simply
 * absent from the baseline, and `git diff --name-only` between the two tree objects
 * reports it as "added" no matter what its bytes are. The untracked half below now
 * *nets that out*: for a path that left the untracked list it looks up the blob the new
 * tree actually holds there and, when that equals the hash recorded at run start,
 * `delete`s the path the tracked diff added — and symmetrically for a path that entered
 * the untracked list (`git rm --cached`), against the blob `run.tree` held. Only the
 * transitions are reconciled; a path tracked at both ends is the tracked diff's alone,
 * and one untracked at both ends is the hash comparison's alone.
 *
 * Netting rather than the merged tree object the bead first sketched (a throwaway index,
 * `git read-tree` + `hash-object -w` + `update-index --cacheinfo` + `write-tree`, so
 * `run.tree` covers both halves at once). That route costs a real write to the object
 * store for every untracked file on every gate start, needs the tracked-only tree kept
 * anyway for `--staged` (untracked content is never staged, so a merged baseline diffed
 * against an index tree would read every baseline-untracked file as removed), and —
 * worse — `--cacheinfo` has to name a mode: seeding untracked files at `100644` makes an
 * executable one committed as `100755` diff as a mode change, which is the same false
 * positive again on exactly the file that prompted this (`bin/b7e-gated` is `chmod +x`).
 * The comparison here is by blob hash, which is mode-blind in both directions and adds
 * no state — at the cost of one batched `git cat-file` per direction, and of a bare
 * `chmod +x` with identical content reading as unchanged, the same as it already did for
 * a file that stayed untracked throughout.
 *
 * `staged: true` compares the run's baseline against the INDEX right now rather than
 * the working tree — useful immediately before a commit, to ask "if I commit exactly
 * what's staged, does that still match what was gated?" The baseline itself is always
 * the working tree `startRun` saw, because that is the tree the suites actually ran
 * against; `staged` only changes what "now" means.
 */
export async function compareToTree(run, { staged = false, cwd = run.cwd } = {}) {
  if (!run.tree || !cwd) return { matches: null, reason: 'no-baseline', changed: [] };
  const nowTree = await ok(staged ? snapshotIndexTree(cwd) : snapshotTree(cwd));
  if (nowTree === null) return { matches: null, reason: 'git-error', changed: [] };
  // `--staged` compares tracked content against the index, but an untracked file is
  // never in the index either way, so its presence still reads off the working tree.
  const nowUntracked = await untrackedHashes(cwd);

  // Deliberately not short-circuited on `nowTree === run.tree`: two `stash create`
  // calls over an UNCHANGED dirty tree still mint two different commit objects (the
  // synthetic "WIP on ..." commit carries its own author/committer timestamp), so
  // comparing the shas themselves would report drift on every run with any
  // pre-existing local edit — which is the common case, not the rare one, since a
  // gate is usually run against a tree that is already mid-change. `git diff
  // --name-only` compares the two commits' TREES, which is the actual question, and
  // is empty whenever the content is identical regardless of which commit shas hold it.
  const changed = new Set();
  const diffOut = (await ok(git(cwd, ['diff', '--name-only', run.tree, nowTree]))) || '';
  for (const f of diffOut.split('\n').filter(Boolean)) changed.add(f);

  const before = run.untracked || {};
  const after = nowUntracked;
  // The two sets of paths that crossed the tracked/untracked line since the run started —
  // the only ones the tracked diff above and the untracked record below can disagree
  // about, and so the only ones worth asking a tree what it holds.
  const left = Object.keys(before).filter((f) => !after[f]);
  const arrived = Object.keys(after).filter((f) => !before[f]);
  const nowBlobs = await blobsAt(cwd, nowTree, left);
  const wasBlobs = await blobsAt(cwd, run.tree, arrived);

  for (const f of Object.keys(before)) {
    if (after[f]) {
      if (before[f] !== after[f]) changed.add(f); // still untracked, content moved
    } else if (nowBlobs[f] === before[f]) {
      // No longer untracked, but the blob the new tree holds here is the one recorded at
      // run start: `git add`ed (staged or committed) with its bytes intact. The tracked
      // diff has already named it, purely because the path is absent from a baseline that
      // could never have held it — so take it back out.
      changed.delete(f);
    } else {
      changed.add(f); // added with different bytes, or simply gone
    }
  }
  for (const f of arrived) {
    // Newly untracked — either a brand-new file (drift, and the common case), or one that
    // left the index with its bytes intact (`git rm --cached`), which the tracked diff
    // reports as a deletion for the mirror-image reason. Same reconciliation, the other
    // way round: against the blob the run's own baseline tree held here.
    if (wasBlobs[f] === after[f]) changed.delete(f);
    else changed.add(f);
  }

  return { matches: changed.size === 0, reason: changed.size === 0 ? null : 'tree-moved', changed: [...changed].sort() };
}

/**
 * The most recent run for a worktree — filename-prefix match, so this never opens a
 * file it does not need to. `--run <id>` in `bin/b7e-watch` skips straight to
 * `readRun(runFile(dir, id))` instead and needs none of this.
 */
export async function latestRunFor(cwd, { worktree } = {}) {
  const dir = await runsDir(cwd);
  const slug = worktree || (await worktreeSlug(cwd));
  const files = listRunFiles(dir).filter((f) => path.basename(f).startsWith(`${slug}-`));
  return files.length ? files[0] : null;
}

/**
 * `'ok' | 'FAIL' | 'TIMEOUT'` for a single result record (`{status, tail}`, as
 * `readRun`'s `results` holds them). `appendResult`'s own `status` field only ever
 * stores `'ok'`/`'fail'` — `bin/b7e-gate`'s `onResult` collapses `FAIL` and `TIMEOUT`
 * into `'fail'` before writing (see its own header) — so `TIMEOUT` is recovered from
 * the one place it survives: the tail text `runSuite` (`lib/gate.js`) appends to a
 * suite's own output when it is killed for running past its budget (`"timed out after
 * Xs — killed"`), which `appendResult` keeps as the last lines of `tail` for any
 * non-`'ok'` result.
 */
export function verdictFor(result) {
  if (!result) return null;
  if (result.status === 'ok') return 'ok';
  if (/timed out after .+ — killed/.test(result.tail || '')) return 'TIMEOUT';
  return 'FAIL';
}

/**
 * `bin/b7e-ran` (bc-dgx7.92) — one record per name in `names`, against `run` (as
 * `readRun` returns it): `{suite, ran, status, verdict, elapsed, tail, runId}`. `ran` is
 * `false`, and `status`/`verdict`/`elapsed` are all `null`, when the suite produced no
 * `result` line at all — a `b7e-gate` run that never reached it, or a name that was
 * never selected in the first place. That is the exact ambiguity a `grep` for a suite's
 * basename cannot resolve (see this file's own header: bc-dgx7.80 spent four calls
 * building this by hand, and five suites its own run had never touched read as either
 * "not there" or "there and green" depending on the pattern).
 */
export function resultsFor(run, names) {
  const bySuite = new Map((run.results || []).map((r) => [r.suite, r]));
  return names.map((suite) => {
    const r = bySuite.get(suite);
    if (!r) return { suite, ran: false, status: null, verdict: null, elapsed: null, tail: undefined, runId: run.runId };
    return {
      suite,
      ran: true,
      status: r.status,
      verdict: verdictFor(r),
      elapsed: r.elapsed ?? null,
      tail: r.tail,
      runId: run.runId,
    };
  });
}

/**
 * Every suite `run` selected (its `start` line's own `suites` list) that produced no
 * `result` line at all — the set difference a `comm -23 <(sort --list) <(sort ran)`
 * used to stand in for, by hand, once per bug (bc-dgx7.80's debrief). `[]` when `run`
 * predates `startRun` recording `suites` on the `start` line — nothing to diff against,
 * not a claim that nothing is missing.
 */
export function missingFrom(run) {
  if (!run.suites) return [];
  const done = new Set((run.results || []).map((r) => r.suite));
  return run.suites.filter((s) => !done.has(s));
}

/**
 * Colour off a suite's recorded tail, so what is printed is text rather than terminal
 * bytes.
 *
 * `appendResult` stores whatever a suite actually wrote, escape codes and all — a
 * `check()` helper's own green tick and red cross are the usual ones here. The
 * bracket-and-letter half is optional so a lone escape byte with nothing recognisable
 * after it comes off too: it is invisible in every reader, survives a naive strip, and
 * is exactly the control byte `test/filter.mjs` fails this repo for when one reaches a
 * tracker field. Deliberately a second copy of `lib/pr.js`'s identical regex rather
 * than an import: that module is the whole pull-request surface (`gh`, the board, the
 * review loop) and `bin/b7e-gate` imports this one once per gate run.
 *
 * bc-dgx7.66 is what made this a function at all. `bc-xl7n.131.1` reached the same
 * answer by hand with a `cat -v` piped into a `sed` over the printable rendering of an
 * escape, which died with `sed: RE error: illegal byte sequence` until it was rerun as
 * an `LC_ALL=C sed` over the real byte into a second file — four calls to read one
 * suite's output.
 */
const ANSI = /\x1b(?:\[[0-9;]*[A-Za-z])?/g;
export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

/**
 * `bin/b7e-why` (bc-dgx7.66) — what each suite in `names` actually printed, out of
 * `run`'s own record and nothing else. One record per name, in `resultsFor`'s shape
 * plus `why`: the recorded `tail` with ANSI stripped, or `null` where there is none.
 *
 * `names` defaults to `run.failed` — "the failing suites of this run", which is the
 * question five sessions asked (see `bin/b7e-why`'s header) and none of them could ask
 * of anything but the raw log. A name given explicitly is answered whatever it did: a
 * suite that *passed* comes back `ran: true, verdict: 'ok'` with `why: null`, which is
 * the caller's cue to say so rather than print nothing — the acceptance criterion
 * bc-dgx7.66 was filed with.
 *
 * Nothing here runs a suite. That is the entire point: the tail was written down when
 * the gate ran it, and re-running to see it again costs the minutes this exists to
 * save. Whether a red is also `origin/main`'s is a different question with a different
 * price — a local run plus an `origin/main` one — and it stays where it already lives,
 * in `lib/blame.js`, reached through `b7e-watch`.
 */
export function whyFor(run, names) {
  const chosen = names && names.length ? names : run.failed || [];
  return resultsFor(run, chosen).map((r) => ({ ...r, why: r.tail ? stripAnsi(r.tail) : null }));
}
