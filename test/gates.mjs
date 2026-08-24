#!/usr/bin/env node
//
// b7e-gates — which gate runners are on this Mac, whose worktree each one is, and
// ending only mine (bc-khoe.55).
//
//   npm test
//   node test/gates.mjs
//
// Nothing here reads the real process table or signals a real pid: `discover`'s `deps`
// bag and `endRunner`'s `signal`/`ppidTable` options are fabricated, the same shape
// lib/strays.js's own test drives `listChromes({ps})` with, for the same reason — a
// suite that spawned real gate runners to test this would be slower and flakier than the
// thing it replaces, and could never fabricate the bc-khoe.30.14 case (a detached child
// surviving its own parent's death) on demand the way a fake `ppidTable` can.
//
// The acceptance criteria, in order: two worktrees named correctly and exactly one
// marked MINE; `--end-mine` ends that one and leaves the other untouched; a runner whose
// parent died but whose child survived is still reported, not read as finished; nothing
// outside this worktree is ever signalled; two runners mine is exit 1. A handful of CLI
// calls at the end cover `--help`, `--json` and the refusal pairs only the CLI enforces.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-gates');

const gates = await import(path.join(ROOT, 'lib', 'gates.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ------------------------------------------------------------------------ fixtures */

const WT_MINE = { path: '/repo/.claude/worktrees/mine-a1', branch: 'worktree-mine-a1', locked: true, detached: false, real: '/repo/.claude/worktrees/mine-a1' };
const WT_OTHER = { path: '/repo/.claude/worktrees/other-b2', branch: 'worktree-other-b2', locked: false, detached: false, real: '/repo/.claude/worktrees/other-b2' };

const psLine = (pid, etime, command) => `${String(pid).padStart(6)} ${etime.padStart(11)} ${command}`;

/** A fake `deps` bag for `discover`: no lock held anywhere, two direct-run processes. */
function fakeDeps({ worktrees = [WT_MINE, WT_OTHER], rows = [], cwdByPid = new Map(), lock = null, ppids = new Map() } = {}) {
  return {
    listWorktrees: async () => worktrees,
    psTable: async () => rows.map(parseRow).filter(Boolean),
    ppidTable: async () => ppids,
    cwdOf: async (pid) => (cwdByPid.has(pid) ? cwdByPid.get(pid) : null),
    gateLockStatus: (root) => (lock && lock.root === root ? lock : null),
  };
}

function parseRow(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), etime: m[2], command: m[3] };
}

/* --------------------------------------------------------------------------- discover */

await checkAsync('a direct scripts/test.mjs run in my worktree is found and marked MINE, the other worktree is not', async () => {
  const rows = [psLine(101, '00:05', `node ${WT_MINE.path}/scripts/test.mjs`), psLine(202, '02:00', `node ${WT_OTHER.path}/scripts/coverage.mjs`)];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[101, WT_MINE.path], [202, WT_OTHER.path]]) });
  const { runners } = await gates.discover({ dir: WT_MINE.path, deps });
  assert.equal(runners.length, 2);
  const mine = runners.find((r) => r.pid === 101);
  const other = runners.find((r) => r.pid === 202);
  assert.equal(mine.mine, true);
  assert.equal(mine.runner, 'test.mjs');
  assert.equal(mine.worktree.path, WT_MINE.path);
  assert.equal(other.mine, false);
  assert.equal(other.runner, 'coverage.mjs');
});

await checkAsync('a b7e-gate lock is read as a runner with no lsof involved, and its own pid is not double-counted from ps', async () => {
  const rows = [psLine(303, '01:00', `node ${ROOT}/bin/b7e-gate --dir ${WT_MINE.path}`)];
  const deps = fakeDeps({ rows, lock: { root: WT_MINE.path, pid: 303, startedAt: 1000, lockPath: '/tmp/x.lock' } });
  const { runners } = await gates.discover({ dir: WT_MINE.path, now: 5000, deps });
  assert.equal(runners.length, 1);
  assert.equal(runners[0].pid, 303);
  assert.equal(runners[0].source, 'lock');
  assert.equal(runners[0].ageMs, 4000);
});

await checkAsync('a pid lsof cannot resolve is unresolved, not silently mine and not silently dropped', async () => {
  const rows = [psLine(404, '00:10', 'node /some/where/scripts/test.mjs')];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[404, undefined]]) });
  const { runners } = await gates.discover({ dir: WT_MINE.path, deps });
  assert.equal(runners.length, 1);
  assert.equal(runners[0].unresolved, true);
  assert.equal(runners[0].mine, false);
  assert.match(gates.hazardLine(runners), /could not be matched/);
});

await checkAsync('a pid that is already gone by the time lsof runs is dropped, not reported as a runner', async () => {
  const rows = [psLine(505, '00:10', 'node /some/where/scripts/test.mjs')];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[505, null]]) });
  const { runners } = await gates.discover({ dir: WT_MINE.path, deps });
  assert.equal(runners.length, 0);
});

await checkAsync('a --match pattern covers a scratchpad runner the built-in patterns do not name', async () => {
  const rows = [psLine(606, '00:10', 'node /repo/.claude/worktrees/mine-a1/scratchpad/myrunner.mjs')];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[606, WT_MINE.path]]) });
  const none = await gates.discover({ dir: WT_MINE.path, deps });
  assert.equal(none.runners.length, 0);
  const { runners } = await gates.discover({ dir: WT_MINE.path, match: 'scratchpad/myrunner\\.mjs', deps });
  assert.equal(runners.length, 1);
  assert.equal(runners[0].runner, 'other');
});

await checkAsync('two runners mine is exit-code 1 via exitCodeFor, one is 0', async () => {
  const rows = [psLine(1, '00:01', `node ${WT_MINE.path}/scripts/test.mjs`), psLine(2, '00:02', `node ${WT_MINE.path}/scripts/coverage.mjs`)];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[1, WT_MINE.path], [2, WT_MINE.path]]) });
  const { runners } = await gates.discover({ dir: WT_MINE.path, deps });
  assert.equal(gates.mineCount(runners), 2);
  assert.equal(gates.exitCodeFor(runners), 1);
  assert.match(gates.hazardLine(runners), /2 gates are running/);
});

/* ----------------------------------------------------------------------------- ending */

await checkAsync('endRunner signals the whole descendant tree it snapshotted, not just the top pid', async () => {
  // 900 -> 901 (a suite child) -> 902 (that suite's own grandchild)
  const ppids = new Map([[901, 900], [902, 901], [999, 1]]);
  const sent = [];
  const alive = new Set([900, 901, 902]);
  const signal = (pid, sig) => {
    if (sig === 0) {
      if (!alive.has(pid)) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return;
    }
    sent.push([pid, sig]);
    if (sig === 'SIGTERM' || sig === 'SIGKILL') alive.delete(pid);
  };
  const result = await gates.endRunner({ pid: 900 }, { signal, ppidTable: async () => ppids, sleep: async () => {} });
  assert.deepEqual(result.targets.sort(), [900, 901, 902]);
  assert.deepEqual(sent.map(([p]) => p).sort(), [900, 901, 902]);
  assert.equal(result.ok, true);
  assert.equal(result.survivors.length, 0);
});

await checkAsync('a pid that ignores SIGTERM is escalated to SIGKILL and then reported gone', async () => {
  const ppids = new Map([]);
  const stubborn = new Set([700]);
  let killed = false;
  const signal = (pid, sig) => {
    if (sig === 0) {
      if (killed || !stubborn.has(pid)) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return;
    }
    if (sig === 'SIGKILL') killed = true;
  };
  const result = await gates.endRunner({ pid: 700 }, { signal, ppidTable: async () => ppids, sleep: async () => {} });
  assert.deepEqual(result.escalated, [700]);
  assert.equal(result.ok, true);
});

await checkAsync('a pid nothing can kill is reported as a survivor, never as ended', async () => {
  const ppids = new Map([]);
  const signal = (pid, sig) => {
    if (sig === 0) return; // always alive
    // SIGTERM and SIGKILL are both accepted but do nothing — an unkillable pid
  };
  const result = await gates.endRunner({ pid: 800 }, { signal, ppidTable: async () => ppids, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.survivors, [800]);
});

await checkAsync(
  'the bc-khoe.30.14 case: a parent killed while its child is mid-syscall does not read as finished — the child was signalled directly, from the pre-kill snapshot',
  async () => {
    // 501 is scripts/test.mjs; 502 is the spawnSync'd suite child. Snapshotting descendants
    // BEFORE signalling — not relying on a cascade the parent's own death would have to
    // deliver — is exactly what this suite is proving: 502 gets its own SIGTERM, not a
    // free pass because 501 died first.
    const ppids = new Map([[502, 501]]);
    const alive = new Set([501, 502]);
    const signal = (pid, sig) => {
      if (sig === 0) {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return;
      }
      if (pid === 501) alive.delete(501); // the parent goes down immediately
      // pid 502 stubbornly ignores SIGTERM but not SIGKILL
      if (pid === 502 && sig === 'SIGKILL') alive.delete(502);
    };
    const result = await gates.endRunner({ pid: 501 }, { signal, ppidTable: async () => ppids, sleep: async () => {} });
    assert.deepEqual(result.targets.sort(), [501, 502]);
    assert.deepEqual(result.escalated, [502]);
    assert.equal(result.ok, true);
  },
);

await checkAsync('--end-mine only ever targets a mine-tagged runner, never the other worktree\'s', async () => {
  const rows = [psLine(11, '00:01', `node ${WT_MINE.path}/scripts/test.mjs`), psLine(22, '00:02', `node ${WT_OTHER.path}/scripts/test.mjs`)];
  const deps = fakeDeps({ rows, cwdByPid: new Map([[11, WT_MINE.path], [22, WT_OTHER.path]]) });
  const { runners } = await gates.discover({ dir: WT_MINE.path, deps });
  const signalled = [];
  const alive = new Set([11]);
  const signal = (pid, sig) => {
    if (sig === 0) {
      if (!alive.has(pid)) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return;
    }
    signalled.push(pid);
    alive.delete(pid);
  };
  const mine = runners.filter((r) => r.mine);
  assert.equal(mine.length, 1);
  await gates.endRunner(mine[0], { signal, ppidTable: async () => new Map(), sleep: async () => {} });
  assert.deepEqual(signalled, [11]);
});

await check('--stale spares the newest of several mine runners', () => {
  const runners = [
    { pid: 1, mine: true, startedAt: 1000 },
    { pid: 2, mine: true, startedAt: 3000 },
    { pid: 3, mine: false, startedAt: 9000 },
  ];
  const spared = gates.newestMine(runners);
  assert.equal(spared.pid, 2);
});

/* ------------------------------------------------------------------------------- CLI */

await check('--help exits 0 without touching the process table', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /--end-mine/);
});

await check('--mine and --others together is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--mine', '--others'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

await check('--stale without --end-mine is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--stale'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

await check('a real run against this Mac prints valid JSON and exits 0 or 1, never throws', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', ROOT, '--json'], { encoding: 'utf8', timeout: 20000 });
  assert.ok(run.status === 0 || run.status === 1, `unexpected exit ${run.status}: ${run.stderr}`);
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  for (const line of lines) JSON.parse(line); // throws on malformed output
});

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failure(s)\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[32mall b7e-gates checks passed\x1b[0m');
}
