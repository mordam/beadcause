/**
 * A cached, empty `bd init` workspace — built once per (bd version, prefix, extra
 * flags) and copied into every suite that asks for one, instead of every suite paying
 * for its own `bd init --skip-agents --prefix <x>`.
 *
 * ## Why this exists
 *
 * Nine suites drive the real `bd` binary rather than a stub of it (the argument for
 * that is in test/adoptsweepreal.mjs's own header, and it stands — nothing here fakes
 * `bd`), and every one of them starts by building a workspace nothing in it uses for
 * more than a handful of beads. `bd init` builds a fresh embedded Dolt database to do
 * that — measured at ~28s on a loaded Mac — and nine of those is most of what makes
 * this family a quarter of the gate's total suite-seconds (bc-xlz32.3). The assertions
 * are not the cost; laying an empty database nine times is.
 *
 * ## What a "template" is
 *
 * The directory `bd init --skip-agents --prefix <x> [extra flags]` produces, right
 * after it exits: `.beads/` (the Dolt database, the config, the metadata) plus whatever
 * else `bd` drops at the workspace root (`.gitignore`, mainly). Copying that whole tree
 * onto a fresh scratch directory IS a workspace `bd init` would have produced — `bd`
 * itself cannot tell the difference, because nothing about a Dolt database records how
 * it got onto disk.
 *
 * **Copies are independent.** They are separate directory trees on disk, so a write
 * against one copy is invisible from another and from the template itself — the same
 * property every suite that spawns a fresh `mkdtemp` already relies on, just paid for
 * once instead of nine times. And a copy still takes no Dolt lock any other session or
 * suite is waiting on, for the same reason: it is its own directory, not a shared one.
 * test/bdtemplate.mjs proves both, plus that an upgraded `bd` cannot hand back a stale
 * database.
 *
 * ## Where it lives, and why not `os.tmpdir()` or `os.homedir()`
 *
 * `os.tmpdir()/beadcause-fixture` and friends are the usual answer in this repo (see
 * lib/fixture.js) — but not here: `lib/gate.js` and `scripts/test.mjs` each hand a
 * suite's *child process* its own private `$TMPDIR`, and remove it the moment the suite
 * exits (bc-5isv). A template built under `os.tmpdir()` from inside a suite would be
 * built, and thrown away, by every suite that asked for it — exactly the cost this file
 * exists to remove.
 *
 * `os.homedir()` is not touched by that override, and looked like the obvious fix —
 * except `bd init` refuses under it for a reason that has nothing to do with
 * `BEADS_DIR`: it walks up from `cwd` looking for an ancestor that already has a
 * `.beads`, and on a machine that runs `bd` for its own personal tracking (this one
 * does — see the beads section of the global CLAUDE.md) that ancestor is `$HOME`
 * itself. Every path under it inherits the refusal, `--prefix` and `BEADS_DIR`
 * override or not: `bd init --skip-agents --prefix ta` with `BEADS_DIR` pointed
 * anywhere under `~/anything/ta/.beads` fails with *"Found existing Dolt database:
 * ~/.beads/embeddeddolt/beads — this workspace is already initialized"*, naming a
 * database this file never asked for. So the cache is hardcoded to `/tmp` — a literal
 * absolute path, not `os.tmpdir()`, because the latter is exactly the per-suite
 * override this needs to survive — where `bd` has no ancestor `.beads` to trip over.
 * `BEADCAUSE_BD_TEMPLATE_DIR` moves it, mainly for this file's own suite, so it never
 * touches whatever another session has cached at the real path.
 *
 * ## Keying
 *
 * `<cache>/<bd version string>/<prefix>[_<extra flags>]/`. The version segment is what
 * keeps an upgraded `bd` from handing a suite back a stale database it never actually
 * built. The prefix is part of the key rather than rewritten after copy because at
 * least one suite (test/adoptsweepreal.mjs) asserts against a literal `ar-nope` id,
 * which makes the prefix load-bearing content rather than a label — renaming a Dolt
 * database after the fact (the embedded engine names the database directory, and the
 * database itself, after the prefix bd was given) is a second, riskier problem this
 * file does not need to solve when building the ten distinct templates this repo's
 * suites actually use, once each, is cheap enough not to.
 *
 * ## The lock
 *
 * A plain `mkdirSync` used as a mutex: it either creates the lock directory (this
 * caller builds) or fails EEXIST (somebody else already is), which is atomic on every
 * filesystem this runs on and needs no dependency. A waiter polls for the ready marker
 * rather than for the lock going away, so it never has to also win a second race right
 * after the first lock is released. A lock directory older than the build timeout is
 * presumed to belong to a builder that died mid-build and is reclaimed rather than
 * waited out forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const READY = '.template-ready';

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-');

/** A blocking sleep — the wait for another builder's lock has nothing to `await` from
 *  a suite that may itself be calling this synchronously. */
const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function templateCacheRoot() {
  return process.env.BEADCAUSE_BD_TEMPLATE_DIR || '/tmp/beadcause-bd-template';
}

function bdVersionTag(bdBin) {
  const r = spawnSync(bdBin, ['version'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  return sanitize((r.stdout || r.stderr || '').trim().split('\n')[0] || 'unknown');
}

function templateDir(bdBin, prefix, extraArgs) {
  const version = bdVersionTag(bdBin);
  if (!version) return null;
  const key = sanitize([prefix, ...extraArgs].join('_'));
  return path.join(templateCacheRoot(), version, key);
}

/**
 * Build (or reuse) the template workspace for `prefix`. Returns `{ ok: true, dir }` on
 * success and `{ ok: false, reason }` on failure — the same shape every one of these
 * suites already branches on after a raw `bd init`, on purpose, so swapping this in is
 * a small diff at each call site.
 */
export function ensureBdTemplate({ prefix, bdBin = 'bd', extraArgs = [], timeout = 120_000 } = {}) {
  const dir = templateDir(bdBin, prefix, extraArgs);
  if (!dir) return { ok: false, reason: `no \`${bdBin}\` on PATH` };
  const readyMarker = path.join(dir, READY);
  if (fs.existsSync(readyMarker)) return { ok: true, dir };

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lockDir = `${dir}.lock`;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (fs.existsSync(readyMarker)) return { ok: true, dir };
    if (Date.now() > deadline) return { ok: false, reason: `timed out waiting for the ${path.basename(dir)} template lock` };
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      break; // lock acquired — we build
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, reason: `cannot lock ${lockDir}: ${err.message}` };
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > timeout) {
          fs.rmSync(lockDir, { recursive: true, force: true }); // a dead builder's lock
          continue; // try to take it ourselves right away
        }
      } catch {
        // The lock vanished between the existsSync above and this stat — the holder
        // just finished. Loop around and race the mkdirSync again rather than sleep.
        continue;
      }
      sleep(200);
    }
  }

  try {
    if (fs.existsSync(readyMarker)) return { ok: true, dir }; // built while we queued for the lock
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, BEADS_DIR: path.join(dir, '.beads') };
    const args = ['init', '--skip-agents', '--prefix', prefix, ...extraArgs];
    const init = spawnSync(bdBin, args, { env, cwd: dir, encoding: 'utf8', timeout });
    if (init.status !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, reason: (init.stderr || init.stdout || '').trim().split('\n')[0] || `bd init exited ${init.status}` };
    }
    // Ephemeral lock files `bd` leaves at the workspace root are never part of the
    // shape a fresh init produced — dropping them keeps a copy from looking pre-held.
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.gate.lock')) fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.writeFileSync(readyMarker, `${new Date().toISOString()}\n`);
    return { ok: true, dir };
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * `fs.cpSync` does not carry a directory's mode across — every directory it creates
 * gets the process umask instead, not the source's own bits. `bd init` sets `.beads` to
 * `0700` deliberately and warns on stderr if it is ever looser (`bd list` does too, on
 * every call), so a plain recursive copy would make every suite's workspace noisier
 * than a real `bd init` ever left it. Walked after the copy, source mode wins.
 */
function mirrorModes(src, dest) {
  const mode = fs.statSync(src).mode & 0o777;
  fs.chmodSync(dest, mode);
  if (fs.statSync(src).isDirectory()) {
    for (const entry of fs.readdirSync(src)) mirrorModes(path.join(src, entry), path.join(dest, entry));
  }
}

/**
 * Copy a template workspace's contents into `destRoot` — a suite's own scratch
 * directory. `destRoot` may already exist (several suites pre-`mkdir` the `.beads`
 * subdirectory before this used to be where `bd init` ran); the copy merges into it.
 */
export function materializeBdWorkspace(dir, destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === READY) continue;
    const src = path.join(dir, entry);
    const dest = path.join(destRoot, entry);
    fs.cpSync(src, dest, { recursive: true });
    mirrorModes(src, dest);
  }
}

/**
 * The two together — what every suite in this family actually wants: a workspace at
 * `destRoot` as if `bd init --skip-agents --prefix <prefix> [extraArgs]` had just run
 * there. `{ ok: false, reason }` on the way out mirrors what these suites already did
 * with a failed `bd init`'s `spawnSync` result, so most call sites change one line.
 */
export function provisionBdWorkspace({ prefix, destRoot, bdBin = 'bd', extraArgs = [], timeout = 120_000 } = {}) {
  const tpl = ensureBdTemplate({ prefix, bdBin, extraArgs, timeout });
  if (!tpl.ok) return tpl;
  try {
    materializeBdWorkspace(tpl.dir, destRoot);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
