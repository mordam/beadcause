#!/usr/bin/env node
/**
 * `b7e-window` — is another live window already on this bead? lib/window.js and
 * bin/b7e-window.
 *
 *     npm test
 *     node test/b7ewindow.mjs
 *
 * bc-dgx7.88's own acceptance criteria, replayed: run from a session opened on some bead
 * it prints that session's own pid and exits 0; with a second window live on the same
 * bead it names both and exits 1; `--family` on an epic reproduces the per-bead census
 * a couple of deluvia sessions assembled by hand; and it never counts its own
 * `ps`/`grep`-shaped invocation as a match. The process table is injected in the shape
 * lib/claude.js's own tests already take it (test/onewindow.mjs) — the pids in the
 * fixtures are real (this process's own, and its parent's), because `processLines` drops
 * any row whose pid is not alive, and a fabricated pid would be filtered out before the
 * match, passing the test for the wrong reason. The CLI itself is spawned for real
 * against a fake `bd`, same shape as test/b7ehandback.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-window');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ewindow-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { processLines, ownClaudePid, windowsNaming, familyIds, censusFamily } = await import(LIB('window.js'));

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nb7e-window — is another live window already on this bead\n');

/* ---------------------------------------------------------------------- processLines */

/** A `ps -Ao pid=,etime=,args=` line naming `<id>` on `pid`, in the shape a real worker
 *  brief's argv has — the first line of the prompt puts the qualified id there. */
const psLine = (pid, etime, id) => `  ${pid} ${etime} /usr/bin/claude --permission-mode auto -- You are working bead **${id}**, opened`;

await check('processLines parses pid/etime/args and drops dead pids', async () => {
  const DEAD_PID = 999999; // astronomically unlikely to be alive; if it is, this Mac has bigger problems
  const lines = await processLines({
    ps: async () => [psLine(process.pid, '01:23', 'demo/zz-1'), psLine(DEAD_PID, '99:99', 'demo/zz-1')].join('\n'),
  });
  assert.deepEqual(
    lines.map((l) => l.pid),
    [process.pid]
  );
  assert.equal(lines[0].etime, '01:23');
  assert.match(lines[0].args, /demo\/zz-1/);
});

await check('processLines is best-effort: a throwing ps is an empty list, not a crash', async () => {
  const lines = await processLines({
    ps: async () => {
      throw new Error('ps: no');
    },
  });
  assert.deepEqual(lines, []);
});

/* ---------------------------------------------------------------------- windowsNaming */

await check('windowsNaming matches the qualified id and nothing else', async () => {
  const lines = await processLines({ ps: async () => psLine(process.pid, '00:05', 'demo/zz-1') });
  assert.deepEqual(windowsNaming(lines, 'demo', 'zz-1'), [{ pid: process.pid, etime: '00:05', bead: 'zz-1' }]);
  assert.deepEqual(windowsNaming(lines, 'demo', 'zz-2'), [], 'a neighbour is not it');
});

await check('windowsNaming does not match a bare id quoted in prose', async () => {
  const prose = async () => `  ${process.pid} 00:05 /usr/bin/claude -- discussing zz-1 as an example, not the qualified pair`;
  const lines = await processLines({ ps: prose });
  assert.deepEqual(windowsNaming(lines, 'demo', 'zz-1'), []);
});

await check('windowsNaming does not match a dotted child, nor the reverse', async () => {
  const childLine = await processLines({ ps: async () => psLine(process.pid, '00:05', 'demo/zz-1.2') });
  assert.deepEqual(windowsNaming(childLine, 'demo', 'zz-1'), [], 'zz-1.2 is not zz-1');

  const parentLine = await processLines({ ps: async () => psLine(process.pid, '00:05', 'demo/zz-1') });
  assert.deepEqual(windowsNaming(parentLine, 'demo', 'zz-1.2'), [], 'nor the reverse');
});

await check('two live windows on the same bead are both named', async () => {
  const lines = await processLines({
    ps: async () => [psLine(process.pid, '00:05', 'demo/zz-1'), psLine(process.ppid, '10:00', 'demo/zz-1')].join('\n'),
  });
  const rows = windowsNaming(lines, 'demo', 'zz-1');
  assert.deepEqual(
    rows.map((r) => r.pid).sort(),
    [process.pid, process.ppid].sort()
  );
});

await check('the CLI never counts its own ps/grep-shaped invocation as a match', async () => {
  // b7e-window's own argv ("node b7e-window -w demo -b zz-1") never contains the
  // qualified "demo/zz-1" substring — the workspace and bead are separate argv tokens —
  // so this needs no exclusion of its own. Prove it against a fake line shaped exactly
  // like that invocation, which must not match.
  const lines = await processLines({
    ps: async () => `  ${process.pid} 00:00 node /path/to/bin/b7e-window -w demo -b zz-1`,
  });
  assert.deepEqual(windowsNaming(lines, 'demo', 'zz-1'), [], 'argv tokens "-w demo -b zz-1" must not read as "demo/zz-1"');
});

/* ---------------------------------------------------------------------- ownClaudePid */

const sessDir = path.join(tmp, 'sessions');
fs.mkdirSync(sessDir, { recursive: true });
const cfg = { claudeSessionsDir: sessDir };

await check('ownClaudePid walks up ppid until it finds a pid with a session record', async () => {
  fs.writeFileSync(path.join(sessDir, `${process.ppid}.json`), '{}');
  const ppids = new Map([
    [12345, process.ppid],
    [process.ppid, 1],
  ]);
  assert.equal(await ownClaudePid(cfg, { ppids, pid: 12345 }), process.ppid);
  fs.rmSync(path.join(sessDir, `${process.ppid}.json`));
});

await check('ownClaudePid gives up rather than walking forever, and returns null', async () => {
  const ppids = new Map([
    [1, 2],
    [2, 1],
  ]); // a cycle with no session file anywhere
  assert.equal(await ownClaudePid(cfg, { ppids, pid: 1 }), null);
});

/* ------------------------------------------------------------------------ familyIds */

/** A minimal `bd.graph()`-shaped index: `beads` (id -> row) and `parents` (child -> parent). */
function indexOf(rows) {
  const beads = new Map(rows.map((r) => [r.id, r]));
  const parents = new Map();
  for (const r of rows) if (r.parent) parents.set(r.id, r.parent);
  return { beads, parents };
}

await check('familyIds widens to the nearest root above the bead, and everything under it', async () => {
  const index = indexOf([
    { id: 'ep-1', issue_type: 'epic', priority: 2 },
    { id: 'ep-1.1', issue_type: 'task', priority: 2, parent: 'ep-1' },
    { id: 'ep-1.2', issue_type: 'task', priority: 2, parent: 'ep-1' },
    { id: 'ep-1.2.a', issue_type: 'task', priority: 2, parent: 'ep-1.2' },
    { id: 'other', issue_type: 'task', priority: 2 },
  ]);
  assert.deepEqual(new Set(familyIds(index, 'ep-1.2')), new Set(['ep-1', 'ep-1.1', 'ep-1.2', 'ep-1.2.a']));
  assert.ok(!familyIds(index, 'ep-1.2').includes('other'));
});

await check('familyIds run on the epic itself reproduces the whole subtree', async () => {
  const index = indexOf([
    { id: 'ep-1', issue_type: 'epic', priority: 2 },
    { id: 'ep-1.1', issue_type: 'task', priority: 2, parent: 'ep-1' },
    { id: 'ep-1.2', issue_type: 'task', priority: 2, parent: 'ep-1' },
  ]);
  assert.deepEqual(new Set(familyIds(index, 'ep-1')), new Set(['ep-1', 'ep-1.1', 'ep-1.2']));
});

await check('an orphan with no root above it is its own family of one', async () => {
  const index = indexOf([{ id: 'lonely', issue_type: 'task', priority: 2 }]);
  assert.deepEqual(familyIds(index, 'lonely'), ['lonely']);
});

await check('censusFamily unions windowsNaming across every id in the family', async () => {
  const lines = await processLines({
    ps: async () => [psLine(process.pid, '00:05', 'demo/ep-1.1'), psLine(process.ppid, '00:10', 'demo/ep-1.2')].join('\n'),
  });
  const rows = censusFamily(lines, 'demo', ['ep-1', 'ep-1.1', 'ep-1.2']);
  assert.deepEqual(
    rows.map((r) => `${r.bead}:${r.pid}`).sort(),
    [`ep-1.1:${process.pid}`, `ep-1.2:${process.ppid}`].sort()
  );
});

/* --------------------------------------------------------------------------- the CLI */

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'show') {
  const id = args[1];
  if (id === 'zz-missing') { process.stderr.write('Error: no issue found matching "' + id + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify([{ id, title: 'a bead', status: 'open', issue_type: 'task', priority: 2, labels: [] }]));
  process.exit(0);
}
if (args[0] === 'export') {
  const rows = [
    { id: 'ep-1', title: 'the epic', status: 'open', issue_type: 'epic', priority: 2, labels: [], dependencies: [] },
    { id: 'zz-1', title: 'a bead', status: 'open', issue_type: 'task', priority: 2, labels: [], dependencies: [{ type: 'parent-child', issue_id: 'zz-1', depends_on_id: 'ep-1' }] },
    { id: 'zz-2', title: 'another', status: 'open', issue_type: 'task', priority: 2, labels: [], dependencies: [{ type: 'parent-child', issue_id: 'zz-2', depends_on_id: 'ep-1' }] },
  ];
  process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\\n'));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      claudeSessionsDir: sessDir,
      workspaces: [{ name: 'demo', dir: wsDir }],
    },
    null,
    2
  )
);

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: process.env });

await check('usage: -w/-b are required, exit 2', async () => {
  const r1 = run([]);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /-w\/--workspace is required/);
  const r2 = run(['-w', 'demo']);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /-b\/--bead is required/);
});

await check('an unknown workspace or bead exits 4', async () => {
  const r1 = run(['-w', 'nope', '-b', 'zz-1']);
  assert.equal(r1.status, 4);
  assert.match(r1.stderr, /no workspace named "nope"/);
  const r2 = run(['-w', 'demo', '-b', 'zz-missing']);
  assert.equal(r2.status, 4);
  assert.match(r2.stderr, /has no bead zz-missing/);
});

await check('a bead nothing is live on: exits 0, says so', async () => {
  const r = run(['-w', 'demo', '-b', 'zz-1']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing live names it/);
});

await check('--json on an unworked bead is machine-readable and still exits 0', async () => {
  const r = run(['-w', 'demo', '-b', 'zz-1', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.workspace, 'demo');
  assert.deepEqual(out.rows, []);
});

/**
 * The one true end-to-end case: two REAL background processes whose argv names the same
 * qualified bead, checked against the CLI's own (real) `ps` call — not an injected one.
 * `processLines`'s injection point is proven above; this proves the CLI actually reads
 * the real process table the same way.
 *
 * Waits on EVIDENCE that the real process table has caught up with the spawn, not on the
 * clock — a fixed sleep here does not merely flake under a loaded gate, it goes green for
 * the wrong reason (a run this test failed under `b7e-gate --jobs 6` gate load, at 300ms).
 * See `[[a-fixed-sleep-after-spawn-inverts-a-suite-rather-than-flaking-it]]`. A poll that
 * never sees the marker within budget is a broken fixture, not a failed assertion — it
 * throws rather than letting the caller's own assertions fail for the wrong reason.
 */
async function waitForMarked(pids, marker, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await processLines();
    const seen = new Set(lines.filter((l) => l.args.includes(marker)).map((l) => l.pid));
    if (pids.every((p) => seen.has(p))) return;
    if (Date.now() >= deadline) {
      throw new Error(`fixture broken: real ps never showed ${pids.length} process(es) naming "${marker}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function withMarkedChildren(id, count, fn) {
  const children = [];
  try {
    for (let i = 0; i < count; i += 1) {
      // The marker is the qualified pair itself, appended as an inert extra argv token —
      // real Claude Code puts the identical string in a worker's prompt argument.
      const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `marker:${id}`], {
        stdio: 'ignore',
      });
      children.push(c);
    }
    await waitForMarked(
      children.map((c) => c.pid),
      id
    );
    await fn();
  } finally {
    for (const c of children) c.kill('SIGKILL');
  }
}

await check('a bead with one real live process naming it: seen, exit 0', async () => {
  await withMarkedChildren('demo/zz-real1', 1, async () => {
    const r = run(['-w', 'demo', '-b', 'zz-real1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pid \d+/);
  });
});

await check('a bead with two real live processes naming it: both named, exit 1', async () => {
  await withMarkedChildren('demo/zz-real2', 2, async () => {
    const r = run(['-w', 'demo', '-b', 'zz-real2']);
    assert.equal(r.status, 1);
    const pidCount = (r.stdout.match(/pid \d+/g) || []).length;
    assert.equal(pidCount, 2);
    assert.match(r.stdout, /2 live windows/);
  });
});

await check('--family on an epic reports every bead under it, and always exits 0', async () => {
  await withMarkedChildren('demo/zz-1', 1, async () => {
    const r = run(['-w', 'demo', '-b', 'ep-1', '--family']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /family of 3/);
    assert.match(r.stdout, /zz-1\s+pid \d+/);
  });
});

await check('--family --json carries the ids and rows for a machine reader', async () => {
  const r = run(['-w', 'demo', '-b', 'ep-1', '--family', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.ids.sort(), ['ep-1', 'zz-1', 'zz-2'].sort());
});

/* -------------------------------------------------------------------------- summary */

console.log(`\n${ran - failures}/${ran} ok\n`);
await cleanupTmp(tmp);
process.exitCode = failures ? 1 : 0;
