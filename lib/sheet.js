/**
 * `bin/b7e-sheet` — render one of sophab's named drawing sheets (E1-E9, S1-S10) at a
 * named size, so a session no longer hand-rolls the render preamble to look at one.
 *
 * bc-dgx7.13, filed by the session audit (`lib/sessionaudit.js`) against three sophab
 * sessions (`sp-zg9`, `sp-vbm`, `sp-0l0`) that each wrote the same three-part preamble —
 * force the Agg backend, build params for a size through `webapp.engine.build_params`,
 * call the sheet's builder and save — before doing anything else. sp-vbm's version
 * crashed first time on `import engine` (it lives at `webapp.engine`, not top level).
 *
 * The actual rendering — matplotlib, the sophab domain modules, the sheet registries —
 * cannot live here: it needs sophab's own `numpy`/`matplotlib`/`solarium` stack, which
 * this repo has no reason to depend on. So this file is a thin spawn wrapper around
 * `tools/sheet_probe.py` in the sophab checkout (companion PR:
 * github.com/NeanderthalMan/sophab#54), run through sophab's own shared `.venv` — the
 * same `.venv/bin/python` every worktree there already uses for `tools/partest.py`,
 * which is what makes this work from a sophab worktree with no `.venv` of its own
 * (there is none to have; every worktree there shares the main checkout's).
 *
 * `sophabRoot` is injectable (not just read from `process.env`/`os.homedir()`) and
 * `spawn` is injectable (not just `child_process.spawnSync`), the same shape
 * `lib/plate.js` uses for `sips`/`python3`, so `test/b7esheet.mjs` can exercise argv
 * building, availability checking and exit-code forwarding without the real sophab
 * checkout existing on the machine running the suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Default location of the sophab checkout on this Mac — this is single-machine
 * tooling, same as every other b7e-* command that assumes "this Mac". Overridable
 * with `--dir` or `SOPHAB_DIR`, and injectable directly for tests. */
export function defaultSophabRoot() {
  return process.env.SOPHAB_DIR || path.join(os.homedir(), 'neadamthal.projects', 'sophab');
}

/** What's missing before a real render can run, or `null` if nothing is. Checked
 * up front so a caller gets one clear refusal instead of a python traceback. */
export function sheetProbeProblem(sophabRoot) {
  if (!fs.existsSync(sophabRoot)) {
    return `no sophab checkout at ${sophabRoot} (set SOPHAB_DIR or pass --dir)`;
  }
  const script = path.join(sophabRoot, 'tools', 'sheet_probe.py');
  if (!fs.existsSync(script)) {
    return `${script} does not exist -- companion sophab PR not merged yet?`;
  }
  const python = path.join(sophabRoot, '.venv', 'bin', 'python3');
  if (!fs.existsSync(python)) {
    return `no .venv at ${sophabRoot}/.venv -- this must run against the sophab MAIN checkout, which owns the shared venv`;
  }
  return null;
}

/**
 * Runs `tools/sheet_probe.py` in `sophabRoot` and returns its
 * `{ status, stdout, stderr }`. `sheets` and `size` are passed through verbatim (the
 * python side owns their syntax); `out`/`text`/`json` map to its own flags.
 */
export function runSheetProbe({ sheets, size, out, text, json, sophabRoot }, spawn = spawnSync) {
  const python = path.join(sophabRoot, '.venv', 'bin', 'python3');
  const script = path.join(sophabRoot, 'tools', 'sheet_probe.py');
  const args = [script, sheets, '--size', size];
  if (out) args.push('--out', out);
  if (text) args.push('--text');
  if (json) args.push('--json');
  return spawn(python, args, {
    cwd: sophabRoot,
    env: { ...process.env, PYTHONPATH: sophabRoot },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}
