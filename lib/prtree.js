/**
 * A reviewer's own runnable copy of a pull request — a real directory on disk, made
 * once, from a sha nothing else on the Mac can move out from under it.
 *
 * `bc-dgx7.38`, filed by the session audit against three sessions that each needed to
 * *run* code from a pull request rather than read it, and each assembled the tree a
 * different way. `bc-36xx.24` built one by hand (`git archive FETCH_HEAD | tar -x`) and
 * it worked. `bc-zjab.12` built the same thing from the same recipe and it did not:
 * midway through the run, `gh pr view <n> --json headRefOid` said one sha and
 * `git rev-parse FETCH_HEAD` said another — a concurrent `git fetch` from somewhere else
 * on this Mac had overwritten `FETCH_HEAD` between the fetch and the archive. `bc-36xx.9`
 * never built a tree at all and read the pull request one `git show <ref>:<path>` at a
 * time instead, nine calls of hunting for what one archive would have handed over whole.
 *
 * **The fix is not "fetch, then hurry" — it is never reading `FETCH_HEAD` at all.**
 * Every path through this file resolves a full 40-character sha *first*, from something
 * nobody else can move (`gh pr view`'s `headRefOid`, or `git ls-remote`'s answer for
 * `refs/pull/<n>/merge`), and only then fetches — with `--no-write-fetch-head`, so the
 * fetch itself never touches the one file that bit `bc-zjab.12`. `git fetch origin <sha>`
 * (a bare, already-known sha, not a ref name) works against GitHub even for a commit
 * that is not at the tip of anything — verified live against this repo's own origin
 * while building this file: `refs/pull/678/merge`'s sha, absent locally, fetched clean
 * with nothing but the sha on the command line. From there, `git archive <sha>` is
 * exactly as deterministic as the sha is: two calls with the same sha produce identical
 * bytes, on this Mac or any other, whatever else is happening to `FETCH_HEAD` at the time.
 *
 * **Nothing here is ever written under the repo it reads from, `~/.config/beadcause`, or
 * the machine's home directory at all.** Every tree lives under `os.tmpdir()`, in a
 * directory named for `--name` so a second call with the same name can find and replace
 * the first — the same promise, and the same `assertContained` shape, as
 * `lib/sandbox.js` makes for a throwaway `bd` tracker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { view } from './pr.js';
import { CONFIG_DIR as REAL_CONFIG_DIR } from './config.js';

const run = promisify(execFile);

/** Where every tree lives — one subdirectory per `--name`, never under `os.homedir()`. */
export function treeRoot() {
  return path.join(os.tmpdir(), 'beadcause-prtree');
}

/**
 * Guard against the one mistake this whole file exists to make impossible: a path that
 * resolves outside the tree's own directory, into the real config directory or the real
 * home (which is where `~/beads` and every personal `bd` workspace live). Thrown rather
 * than logged, for the same reason `lib/sandbox.js` throws here — a tree that cannot
 * prove this about itself must not be handed back as though it were safe to `cd` into.
 */
function assertContained(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`refusing to write outside the tree: ${t} is not under ${r}`);
  }
  const home = path.resolve(os.homedir());
  if (t === home || t.startsWith(home + path.sep)) {
    throw new Error(`refusing to write under the home directory: ${t}`);
  }
  const cfg = path.resolve(REAL_CONFIG_DIR);
  if (t === cfg || t.startsWith(cfg + path.sep)) {
    throw new Error(`refusing to write under the real CONFIG_DIR: ${t}`);
  }
}

/** The first field of `git ls-remote origin <ref>` — null when the ref does not exist. */
async function lsRemoteSha(repoRoot, refName) {
  let out;
  try {
    ({ stdout: out } = await run('git', ['ls-remote', 'origin', refName], {
      cwd: repoRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    throw new Error(`git ls-remote origin ${refName}: ${String(err.stderr || err.message || '').trim()}`);
  }
  const line = out.split('\n').find(Boolean);
  return line ? line.split('\t')[0].trim().toLowerCase() : null;
}

/** `headRefOid`, by way of `lib/pr.js`'s own account handling — never read from `FETCH_HEAD`. */
async function resolveHeadSha(repoRoot, prNumber, viewPR) {
  const pr = await viewPR(repoRoot, prNumber);
  if (!pr?.headSha) throw new Error(`gh pr view ${prNumber} returned no headRefOid`);
  return { sha: pr.headSha, prNumber: String(prNumber), ref: 'head', branch: pr.branch || null };
}

/**
 * The sha GitHub itself computed for a hypothetical merge of this PR into its base,
 * read with `ls-remote` — a query, not a fetch, so it never writes a local ref or
 * `FETCH_HEAD` either. GitHub only maintains this ref while it believes the PR can be
 * auto-merged; an already-merged, closed, or conflicting PR has none.
 */
async function resolveMergeSha(repoRoot, prNumber) {
  if (!prNumber) throw new Error('--merge needs a pull request number');
  const refName = `refs/pull/${prNumber}/merge`;
  const sha = await lsRemoteSha(repoRoot, refName);
  if (!sha) {
    throw new Error(
      `${refName} was not found on origin — GitHub only keeps this ref for a PR it believes it can ` +
        'auto-merge; an already-merged, closed, or conflicting PR has none. Try without --merge.'
    );
  }
  return { sha, prNumber: String(prNumber), ref: 'merge', branch: null };
}

/**
 * `git fetch --no-write-fetch-head origin <sha>` — a bare, already-known sha, never a
 * ref name, and never followed by a read of `FETCH_HEAD`. Safe to call even when the
 * object is already present locally: verified live, both ways, against this repo's own
 * `origin` while building this file.
 */
async function fetchSha(repoRoot, sha) {
  try {
    await run('git', ['fetch', '--no-write-fetch-head', 'origin', sha], {
      cwd: repoRoot,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git fetch origin ${sha}: ${String(err.stderr || err.message || '').trim() || err.message}`);
  }
}

/** `git archive <sha> | tar -x -C <dir>`, piped process to process — no shell, no temp file. */
function archiveInto(repoRoot, sha, dir) {
  return new Promise((resolve, reject) => {
    const archiveProc = spawn('git', ['archive', sha], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const tarProc = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveErr = '';
    let tarErr = '';
    archiveProc.stderr.on('data', (d) => {
      archiveErr += d;
    });
    tarProc.stderr.on('data', (d) => {
      tarErr += d;
    });
    archiveProc.stdout.pipe(tarProc.stdin);
    // A `tar` that dies early (bad archive) closes its stdin's write side under us;
    // that must not surface as an unhandled 'error' on the pipe.
    archiveProc.stdout.on('error', () => {});
    tarProc.stdin.on('error', () => {});

    let archiveCode = null;
    let tarCode = null;
    let settled = false;
    const finish = () => {
      if (archiveCode === null || tarCode === null || settled) return;
      settled = true;
      if (archiveCode !== 0) return reject(new Error(`git archive ${sha} failed: ${archiveErr.trim() || `exit ${archiveCode}`}`));
      if (tarCode !== 0) return reject(new Error(`tar -x failed: ${tarErr.trim() || `exit ${tarCode}`}`));
      resolve();
    };
    const failNow = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    archiveProc.on('error', failNow);
    tarProc.on('error', failNow);
    archiveProc.on('close', (code) => {
      archiveCode = code;
      finish();
    });
    tarProc.on('close', (code) => {
      tarCode = code;
      finish();
    });
  });
}

/**
 * Build one. `opts`:
 *
 *   repoRoot    the git repository to resolve the sha and fetch from — the caller's own
 *               checkout, whichever worktree that is. Never written to.
 *   name        slug — the tree lives at `treeRoot()/<name>` and a second call with the
 *               same name tears the first down first, unless it was `--keep`.
 *   prNumber    a pull request number, or null when `sha` is given directly.
 *   sha         an explicit sha to build from, bypassing `gh` entirely. Mutually
 *               exclusive with `merge`.
 *   merge       use `refs/pull/<prNumber>/merge` (GitHub's own test-merge commit)
 *               instead of the PR's head. Needs `prNumber`; incompatible with `sha`.
 *   vendor      run `scripts/vendor.js` inside the new tree once it exists, so browser
 *               suites are runnable there too.
 *   keep        if true, a later call with the same `name` refuses rather than deleting.
 *
 * `deps.viewPR` overrides how a PR's head sha is looked up — `lib/pr.js`'s `view` by
 * default, injectable for a test that must not shell out to a real `gh`.
 *
 * Returns `{ dir, sha, prNumber, ref, branch, nodeModulesLinked, vendored }`.
 */
export async function buildTree(opts, deps = {}) {
  const { repoRoot, name, prNumber = null, sha = null, merge = false, vendor: vendorFlag = false, keep = false } = opts || {};
  const viewPR = deps.viewPR || view;

  if (!repoRoot) throw new Error('buildTree needs a repoRoot');
  if (!name) throw new Error('buildTree needs a --name');
  if (sha && merge) {
    throw new Error('--merge names a ref GitHub computes; it cannot be combined with an explicit --sha');
  }
  if (!sha && !prNumber) throw new Error('needs a pull request number or --sha <sha>');

  const resolved = sha
    ? { sha: String(sha).toLowerCase(), prNumber: prNumber ? String(prNumber) : null, ref: 'given', branch: null }
    : merge
      ? await resolveMergeSha(repoRoot, prNumber)
      : await resolveHeadSha(repoRoot, prNumber, viewPR);

  if (!/^[0-9a-f]{40}$/.test(resolved.sha)) {
    throw new Error(`resolved sha "${resolved.sha}" is not a full 40-character sha`);
  }

  const root = treeRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, name);
  const keepMarker = path.join(dir, '.kept-by-a-previous-run');

  if (fs.existsSync(dir)) {
    if (fs.existsSync(keepMarker)) {
      throw new Error(`tree "${name}" was kept by a previous run (${dir}) — remove it by hand, or pick a different --name`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assertContained(root, dir);
  fs.mkdirSync(dir, { recursive: true });

  await fetchSha(repoRoot, resolved.sha);
  await archiveInto(repoRoot, resolved.sha, dir);

  let nodeModulesLinked = false;
  const nm = path.join(repoRoot, 'node_modules');
  if (fs.existsSync(nm)) {
    const target = path.join(dir, 'node_modules');
    assertContained(root, target);
    fs.symlinkSync(nm, target, 'dir');
    nodeModulesLinked = true;
  }

  let vendored = false;
  if (vendorFlag) {
    const vendorScript = path.join(dir, 'scripts', 'vendor.js');
    if (!fs.existsSync(vendorScript)) {
      throw new Error(`--vendor: ${vendorScript} does not exist in this tree`);
    }
    const res = spawnSync(process.execPath, [vendorScript], { cwd: dir, encoding: 'utf8', timeout: 120000 });
    if (res.status !== 0) {
      throw new Error(`--vendor: scripts/vendor.js failed: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`);
    }
    vendored = true;
  }

  if (keep) {
    fs.writeFileSync(keepMarker, 'kept — a later run with this --name will refuse rather than delete it\n');
  }

  return {
    dir,
    sha: resolved.sha,
    prNumber: resolved.prNumber,
    ref: resolved.ref,
    branch: resolved.branch,
    nodeModulesLinked,
    vendored,
  };
}
