/**
 * The Python arm of `b7e-gate` — one process, `tools/partest.py`, gated on its exit
 * code alone.
 *
 * bc-khoe.61 names ten sophab sessions (`sp-2cw`, `sp-zg9`, `sp-42u`, `sp-vbm`, `sp-h3z`,
 * `sp-zli`, `sp-0l0`, `sp-sp9`, `sp-dei.2`, `sp-6bt.1`) that each assembled
 * `PYTHONPATH=. .venv/bin/python tools/partest.py` by hand from a worktree, and every one
 * hit the same trap a fresh worktree never has: no `.venv` of its own. Nine hardcoded the
 * main checkout's absolute interpreter path; the tenth discovered it by listing every
 * sibling directory's own `.venv`. `findInterpreter` below is that walk, done once, in code.
 *
 * The suite itself prints `ERROR:` lines and a logging-teardown traceback on a run that
 * still passes (also named in bc-khoe.61) — `tools/partest.py`'s own docstring says the
 * count comparison is what makes it a gate, not the text on stdout. So `runPythonGate`
 * below never reads `out` to decide anything; the verdict is the child's exit code and
 * nothing else, same as `runSuite` in `lib/gate.js` already does for a Node suite.
 *
 * This is a distinct module rather than a branch inside `lib/gate.js`'s `runSuite`/
 * `runGate`, because a single long-lived Python process running its own `-j` workers is
 * not a suite *list* the way `discoverSuites` produces one — there is nothing here to
 * discover, select or pool. `bin/b7e-gate` reuses `lib/gate.js`'s per-tree lock and
 * machine-wide slot unchanged; this only supplies the one child process those wrap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/** The one marker that says a tree is this arm's shape — nothing else is checked. */
export const PARTEST_REL = path.join('tools', 'partest.py');

/** `true` when `root` is a Python/`partest.py` tree rather than the Node/`scripts/test.mjs` shape. */
export function isPythonShaped(root) {
  return fs.existsSync(path.join(root, PARTEST_REL));
}

const VENV_NAMES = ['python', 'python3'];

/** `<dir>/.venv/bin/<name>` for the first name that exists, or `null`. */
function venvPython(dir) {
  for (const name of VENV_NAMES) {
    const p = path.join(dir, '.venv', 'bin', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * `<root>`'s own `.venv` first — a worktree that happens to carry one (or the main
 * checkout itself) never has to walk anywhere. Failing that, `--git-common-dir` gives the
 * main checkout regardless of how deep `root` is nested under `.claude/worktrees/`, which
 * is the one call every hand-rolled sibling-directory listing in bc-khoe.61's history was
 * standing in for. `null` when neither has one — a real refusal, not a guess.
 */
export function findInterpreter(root) {
  const own = venvPython(root);
  if (own) return own;
  let common;
  try {
    common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      // A non-git `root` is an expected outcome here (any fabricated `--dir` a test drives
      // this against), not a real error — execFileSync echoes a failed child's stderr to
      // ours by default, and without this a caller's own terminal gets a scary "fatal: not
      // a git repository" for a case the caught error already handles quietly.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
  const main = path.dirname(common);
  if (path.resolve(main) === path.resolve(root)) return null; // already checked above
  return venvPython(main);
}

const rel = (root, p) => path.relative(root, p) || '.';

/**
 * One child, `PYTHONPATH=.` so `tools/partest.py` can `import` the package the way the
 * documented command always has, `cwd: root`. `extraArgs` is `tools/partest.py`'s own
 * argv (`-j`, `-v`, or specific module names) — forwarded verbatim, never reinterpreted.
 *
 * `{ ok, code, signal, timedOut, ms, out }`, the same shape `runSuite` (`lib/gate.js`)
 * resolves with — `ok` is `true` only when the process exited `0` with no signal and no
 * timeout. `out` is kept for the caller to print a tail on failure; it is never read here.
 */
export function runPythonGate(root, { interpreter, timeoutMs = 0, extraArgs = [], live } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(interpreter, [PARTEST_REL, ...extraArgs], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: '.' },
      });
    } catch (err) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, ms: Date.now() - started, out: `could not start — ${err.message}\n` });
      return;
    }
    live?.add(child);
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeoutMs)
      : null;
    child.on('error', (err) => {
      live?.delete(child);
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, timedOut: false, ms: Date.now() - started, out: `${out}could not start — ${err.message}\n` });
    });
    child.on('close', (code, signal) => {
      live?.delete(child);
      if (timer) clearTimeout(timer);
      if (timedOut) out += `\ntimed out after ${(timeoutMs / 1000).toFixed(0)}s — killed\n`;
      const ok = !timedOut && !signal && code === 0;
      resolve({ ok, code, signal, timedOut, ms: Date.now() - started, out });
    });
  });
}

/** What `--list` shows for this arm — there is no suite list, only the command itself. */
export function commandLine(root, { interpreter, extraArgs = [] } = {}) {
  return `PYTHONPATH=. ${rel(root, interpreter)} ${PARTEST_REL}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}`;
}
