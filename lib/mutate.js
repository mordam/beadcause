/**
 * Mutation-test a change without hand-rolling the backup-mutate-restore dance —
 * `bin/b7e-mutate` is the argv shell; this is the mutating, the testing and the restore.
 *
 * bc-dgx7.12 names ten sessions (sp-mgq, sp-0l0, sp-zg9, sp-42u, sp-2cw, sp-vbm, sp-zli,
 * sp-dei.2, sp-h3z, sp-sp9) that each wrote this loop by hand, no two of them the same
 * way, to prove a fix actually gets caught by the tests that are supposed to catch it.
 * Two failure modes recurred across them and are handled once here instead of per
 * session: a same-length mutation can be masked by a stale `__pycache__` (a test then
 * reports "caught" over bytecode that was never recompiled), and a mutation that never
 * took — `--from` matching nothing — can silently "pass" as though it had been applied.
 *
 * ## Restoring even when the process is killed mid-run
 *
 * Every mutated file is backed up to a real file under `os.tmpdir()` — "outside the
 * working tree" in the bead's own words, not just a JS string held in this process — and
 * restored from that exact backup **as a `Buffer`**, never round-tripped through a JS
 * string, so the tree is byte-identical afterward regardless of encoding. Restoration is
 * armed through `lib/teardown.js`'s `onExit` the instant a file is mutated, and disarmed
 * only after the restore has actually run — so `SIGINT`/`SIGTERM`/`SIGHUP` mid-mutation
 * still restores (see that file's header for why `SIGKILL` cannot be covered by anything
 * and is out of scope here too).
 *
 * ## Baseline first
 *
 * A green mutation test proves nothing if the suite was already red before the mutation
 * — sp-vbm's own note. Every distinct `test` command a plan actually uses is run once,
 * unmutated, before any file is touched; any of them nonzero refuses the whole run before
 * a single mutation is made.
 *
 * ## What "caught" means
 *
 * Nonzero exit from the test command after mutating = caught (the mutation was
 * detected). Zero exit = SURVIVED — the bug the mutation introduced went unnoticed, which
 * is the finding this command exists to surface. `extractFailedIds` is best-effort, the
 * same discipline `lib/blame.js`'s `extractFailures` already uses for this repo's own
 * `FAIL <name>` convention: a command whose output names no failing test still reports
 * caught/SURVIVED correctly, just with an empty `failed` list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { onExit } from './teardown.js';

/** How many times `needle` occurs in `haystack`, as a literal substring — never a regex. */
function occurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Every `__pycache__` directory under `root`, removed. Skips `.git` and `node_modules` —
 * neither can hold one and both are large enough that walking into them is pure waste.
 * Best-effort: a directory that disappears mid-walk (another process cleaning up) is not
 * an error here.
 */
export function clearPycache(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '__pycache__') {
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        continue;
      }
      stack.push(full);
    }
  }
}

/**
 * Run a test command, shell-parsed the way a worker would type it — asynchronously, on
 * purpose. `spawnSync` blocks the JS thread inside a single synchronous syscall, and a
 * signal delivered while blocked there is not guaranteed to reach `lib/teardown.js`'s
 * handler until that call returns on its own — measured here as `SIGTERM` having no
 * effect until the mutation's own test finished naturally. `spawn` keeps the event loop
 * running while the test executes, so a signal is serviced (and the restore runs) the
 * moment it arrives, not whenever the test command happens to finish.
 */
function runTest(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (err) => resolve({ status: 1, output: String(err?.message || err) }));
    child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 1 : 0), output }));
  });
}

const FAIL_PATTERNS = [
  // This repo's own suite/gate convention (see lib/blame.js's extractFailures).
  /^\s*FAIL\b\s*[-:]?\s*(.+)$/,
  // This repo's own check() helper convention: "  ✗ some check name".
  /^\s*✗\s*(.+?)\s*$/,
  // pytest's failure summary: "FAILED tests/test_foo.py::test_bar - AssertionError".
  /^FAILED\s+(\S+)/,
  // unittest's per-test line: "FAIL: test_name (module.TestCase)".
  /^FAIL:\s*(.+)$/,
];

/**
 * Best-effort names of whatever failed, out of a test command's combined stdout+stderr.
 * Returns `[]` when nothing recognisable was printed — a command that names no failure is
 * not a command with no failures, same caveat `lib/blame.js`'s `extractFailures` documents
 * for this repo's own convention.
 */
export function extractFailedIds(output) {
  const ids = [];
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '');
    for (const re of FAIL_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        const name = m[1].trim();
        if (name) ids.push(name);
        break;
      }
    }
  }
  return ids;
}

/**
 * Parse a plan from YAML text: either a bare list, or `{ mutations: [...] }` — the same
 * shape convention `bin/file.js`'s `beads`/bare-list duality uses. Each record is
 * `{ file, from, to, label?, test? }`; `test` on a record overrides the plan-wide default.
 */
export function parsePlan(YAML, text) {
  const doc = YAML.parse(text);
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.mutations) ? doc.mutations : null;
  if (!list) throw new Error('a plan must be a YAML list, or { mutations: [...] }');
  return list.map((rec, i) => {
    if (!rec || typeof rec !== 'object') throw new Error(`mutation #${i + 1} is not a record`);
    if (!rec.file) throw new Error(`mutation #${i + 1} has no file`);
    if (rec.from === undefined || rec.from === null) throw new Error(`mutation #${i + 1} (${rec.file}) has no from`);
    if (rec.to === undefined || rec.to === null) throw new Error(`mutation #${i + 1} (${rec.file}) has no to`);
    return {
      file: String(rec.file),
      from: String(rec.from),
      to: String(rec.to),
      label: rec.label ? String(rec.label) : null,
      test: rec.test ? String(rec.test) : null,
    };
  });
}

/**
 * Run every mutation in `specs` in order: baseline-check every distinct test command
 * first, then for each mutation back up its file (outside the working tree), verify
 * `from` actually occurs, mutate, clear `__pycache__`, run the test, restore, and record
 * caught/SURVIVED/error. Stops at the first SURVIVED or errored mutation unless
 * `keepGoing`. Returns `{ refused, results }` — `refused` set (and `results: []`) only
 * when a baseline was already red; a mid-run error is a `results` entry, not a refusal.
 */
export async function runMutations(specs, { defaultTest = null, cwd = process.cwd(), keepGoing = false } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-mutate-'));
  try {
    const testCmds = new Set();
    for (const spec of specs) {
      const cmd = spec.test || defaultTest;
      if (cmd) testCmds.add(cmd);
    }
    for (const cmd of testCmds) {
      clearPycache(cwd);
      const baseline = await runTest(cmd, cwd);
      if (baseline.status !== 0) {
        return { refused: `baseline is already red for "${cmd}" — refusing to mutation-test against a failing suite`, results: [] };
      }
    }

    const results = [];
    let backupSeq = 0;
    for (const spec of specs) {
      const label = spec.label || spec.file;
      const testCmd = spec.test || defaultTest;
      if (!testCmd) {
        results.push({ label, file: spec.file, error: 'no test command — pass --test or give this mutation its own' });
        if (!keepGoing) break;
        continue;
      }

      const filePath = path.resolve(cwd, spec.file);
      let original;
      try {
        original = fs.readFileSync(filePath);
      } catch (err) {
        results.push({ label, file: spec.file, error: `could not read ${spec.file}: ${String(err?.message || err).split('\n')[0]}` });
        if (!keepGoing) break;
        continue;
      }

      const originalText = original.toString('utf8');
      const count = occurrences(originalText, spec.from);
      if (count === 0) {
        results.push({ label, file: spec.file, error: `--from matches nothing in ${spec.file}` });
        if (!keepGoing) break;
        continue;
      }

      backupSeq += 1;
      const backupPath = path.join(tmpRoot, `${backupSeq}-${path.basename(filePath)}.bak`);
      fs.writeFileSync(backupPath, original);

      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        fs.writeFileSync(filePath, fs.readFileSync(backupPath));
      };
      const off = onExit(restore);

      let entry;
      try {
        const mutatedText = originalText.split(spec.from).join(spec.to);
        fs.writeFileSync(filePath, mutatedText);
        clearPycache(cwd);
        const r = await runTest(testCmd, cwd);
        const survived = r.status === 0;
        entry = { label, file: spec.file, survived, failed: survived ? [] : extractFailedIds(r.output) };
      } finally {
        restore();
        off();
        const after = fs.readFileSync(filePath);
        if (!after.equals(original)) {
          entry = { label, file: spec.file, error: `restore did not take — ${spec.file} is not byte-identical to before the mutation` };
        }
      }

      results.push(entry);
      if ((entry.error || entry.survived) && !keepGoing) break;
    }

    return { refused: null, results };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** The printed report `bin/b7e-mutate` builds from a `runMutations` result. */
export function describeResults(results) {
  const lines = [];
  for (const r of results) {
    if (r.error) {
      lines.push(`${r.label}: ERROR — ${r.error}`);
    } else if (r.survived) {
      lines.push(`${r.label}: SURVIVED`);
    } else {
      lines.push(`${r.label}: caught${r.failed.length ? ` (${r.failed.join(', ')})` : ''}`);
    }
  }
  return lines;
}
