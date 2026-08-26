#!/usr/bin/env node
/**
 * Noticing a change in five seconds instead of thirty — and not paying for it.
 *
 *     npm test
 *     node test/detect.mjs
 *
 * bc-1kwl.5. The poll cycle used to run everything on one clock, `pollSeconds`, and
 * that number was both the detection latency and the cost ceiling: a change was up to
 * thirty seconds old before the daemon knew, and buying the latency by turning the
 * clock down would have run one `bd human list` per workspace six times as often, all
 * day, almost always to learn that nothing had moved.
 *
 * lib/detect.js splits the two with a cheap question in front of the expensive one:
 * *did anything write to this tracker?*, answered by reading Dolt's own manifest.
 * Three separate claims have to hold for that to be worth anything, and each of them
 * is a way the whole mechanism silently degrades to the old behaviour if it stops
 * being true:
 *
 * 1. **The mark moves on a write and not on a read.** This is a fact about bd and
 *    Dolt, not about this repo, so it is asserted against the *real* `bd` — a stub
 *    could only ever confirm what lib/detect.js already believes. It is the load-
 *    bearing one: a mark that moved on reads would make the daemon sweep forever, and
 *    one that did not move on writes would make it never sweep early at all.
 * 2. **The detector's own bookkeeping**: nothing on first sight, nothing on an
 *    unchanged mark, the name on a changed one, and an unreadable tracker reported as
 *    *no change* rather than as a change — because "I cannot tell" must fall back to
 *    the backstop and never to a sweep.
 * 3. **The cycle uses it**: a poller whose tracker moves sweeps without waiting for
 *    `pollSeconds`, a poller whose tracker is quiet does not, and the slow sweeps stay
 *    on the slow clock however often the fast one beats. That last one is the
 *    acceptance criterion "daemon load with nothing moving does not rise", and it is
 *    the assertion a plausible refactor would break.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import { provisionBdWorkspace } from './helpers/bdtemplate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-detect-'));
// Before the first import of anything under lib/: CONFIG_DIR resolves once, at load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { trackerMark, createChangeDetector, detectIntervalMs } = await import(LIB('detect.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\ndetecting a change without sweeping for it\n');

/* --------------------------------------------------- the mark, against a real bd */

/**
 * A workspace laid down by the real `bd init`, so the file being read is the one Dolt
 * actually writes rather than one this file invented.
 *
 * Spawned directly and never through a shell, for the reason at the top of lib/bd.js:
 * `~/.zshenv` rewrites BEADS_DIR from the shell's cwd, and a shell here would point
 * `bd create` at somebody's actual tracker.
 */
const realRoot = path.join(tmp, 'real');
const realDir = path.join(realRoot, '.beads');
const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
let realWs = null;

if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what Dolt writes cannot be asked here');
} else {
  const env = { ...process.env, BEADS_DIR: realDir };
  const bdRun = (args) => spawnSync('bd', args, { env, cwd: realRoot, encoding: 'utf8', timeout: 120_000 });
  // A cached template stands in for `bd init --skip-agents --prefix dt` — see
  // test/helpers/bdtemplate.mjs.
  const init = provisionBdWorkspace({ prefix: 'dt', destRoot: realRoot });
  if (!init.ok) {
    bad('a temp workspace can be made to watch', init.reason);
  } else {
    realWs = { name: 'real', dir: realDir };

    await check('a real workspace has a mark at all', () => {
      assert.ok(trackerMark(realWs), 'no manifest found under the workspace bd just made');
    });

    await check('a read does not move it — otherwise the sweep detects itself, forever', () => {
      const before = trackerMark(realWs);
      assert.equal(bdRun(['list', '--status=open']).status, 0, 'bd list failed');
      assert.equal(trackerMark(realWs), before, '`bd list` changed the mark');
    });

    await check('a write moves it — which is the whole mechanism', () => {
      const before = trackerMark(realWs);
      const made = bdRun(['create', '--title=probe', '--description=probe', '--type=task', '-p', '2']);
      assert.equal(made.status, 0, (made.stderr || made.stdout || '').split('\n')[0]);
      assert.notEqual(trackerMark(realWs), before, 'a `bd create` left the mark unchanged');
    });

    await check('and it settles again — a write is one step, not a drift', () => {
      const after = trackerMark(realWs);
      assert.equal(bdRun(['list', '--status=open']).status, 0, 'bd list failed');
      assert.equal(trackerMark(realWs), after, 'the mark kept moving with no write');
    });
  }
}

/* ---------------------------------------------------------------- the mark's edges */

await check('a workspace with no dir is unknown, not changed', () => {
  assert.equal(trackerMark({ name: 'nameless' }), null);
  assert.equal(trackerMark(undefined), null);
});

await check('a dir that is not a beads workspace is unknown too', () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(trackerMark({ name: 'plain', dir: plain }), null);
});

/** A hand-built workspace, so the detector's own logic can be driven without bd. */
const fakeDir = path.join(tmp, 'fake', '.beads');
const fakeManifest = path.join(fakeDir, 'embeddeddolt', 'fk', '.dolt', 'noms', 'manifest');
fs.mkdirSync(path.dirname(fakeManifest), { recursive: true });
fs.writeFileSync(fakeManifest, 'root-one');
const fakeWs = { name: 'fake', dir: fakeDir };

const fakeJournal = path.join(
  fakeDir, 'embeddeddolt', 'fk', '.dolt', 'noms', 'vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv',
);

await check('the journal moves the mark on its own — this is the whole server-mode fix', () => {
  // A dolt sql-server defers the manifest rewrite by ~35s but appends to the journal
  // at once, so this case is the server-mode workspace's ONLY signal inside the
  // latency budget. Driven by hand rather than through bd because reproducing it
  // for real needs a running server.
  fs.writeFileSync(fakeJournal, 'aaaa');
  const before = trackerMark(fakeWs);
  fs.appendFileSync(fakeJournal, 'bbbb');
  assert.notEqual(trackerMark(fakeWs), before, 'the journal grew and the mark did not');
});

await check('it is the journal SIZE, not its mtime — reads move mtime under embedded Dolt', () => {
  const before = trackerMark(fakeWs);
  const then = new Date(Date.now() + 60_000);
  fs.utimesSync(fakeJournal, then, then);
  assert.equal(trackerMark(fakeWs), before, 'a touched journal reported a write');
});

await check('it is the size, not the bytes — the journal is 854MB on the real workspace', () => {
  const before = trackerMark(fakeWs);
  const size = fs.statSync(fakeJournal).size;
  fs.writeFileSync(fakeJournal, 'z'.repeat(size));
  assert.equal(trackerMark(fakeWs), before, 'same-size different-bytes reported a write');
});

await check('a workspace with a manifest and no journal is still a mark, not null', () => {
  fs.rmSync(fakeJournal, { force: true });
  assert.ok(trackerMark(fakeWs), 'losing the journal lost the whole mark');
  fs.writeFileSync(fakeJournal, 'aaaa');
});

await check('two databases in one workspace are one mark, and either one moving moves it', () => {
  const second = path.join(fakeDir, 'embeddeddolt', 'zz', '.dolt', 'noms', 'manifest');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, 'zz-one');
  const before = trackerMark(fakeWs);
  fs.writeFileSync(second, 'zz-two');
  assert.notEqual(trackerMark(fakeWs), before, 'the second database moved and the mark did not');
  fs.rmSync(path.join(fakeDir, 'embeddeddolt', 'zz'), { recursive: true, force: true });
});

/* --------------------------------------------------------------- the detector proper */

await check('first sight reports nothing — there is nothing to compare against', () => {
  const d = createChangeDetector();
  assert.deepEqual(d.moved([fakeWs]), []);
});

await check('an unchanged tracker reports nothing', () => {
  const d = createChangeDetector();
  d.moved([fakeWs]);
  assert.deepEqual(d.moved([fakeWs]), []);
  assert.deepEqual(d.moved([fakeWs]), []);
});

await check('a changed tracker reports its name, once', () => {
  const d = createChangeDetector();
  d.moved([fakeWs]);
  fs.writeFileSync(fakeManifest, 'root-two');
  assert.deepEqual(d.moved([fakeWs]), ['fake']);
  assert.deepEqual(d.moved([fakeWs]), [], 'the same change was reported twice');
});

await check('only the workspace that moved is named', () => {
  const otherDir = path.join(tmp, 'other', '.beads');
  const otherManifest = path.join(otherDir, 'embeddeddolt', 'ot', '.dolt', 'noms', 'manifest');
  fs.mkdirSync(path.dirname(otherManifest), { recursive: true });
  fs.writeFileSync(otherManifest, 'other-one');
  const other = { name: 'other', dir: otherDir };
  const d = createChangeDetector();
  d.moved([fakeWs, other]);
  fs.writeFileSync(otherManifest, 'other-two');
  assert.deepEqual(d.moved([fakeWs, other]), ['other']);
});

await check('an unreadable tracker is not a change, and keeps its baseline', () => {
  const d = createChangeDetector({
    mark: (ws) => (ws.name === 'flaky' ? marks.shift() : null),
  });
  // seen → unreadable → the same value it had. The middle beat must not report, and
  // neither must the third: a manifest caught mid-rewrite is not news.
  const marks = ['a', null, 'a', 'b'];
  const flaky = { name: 'flaky' };
  assert.deepEqual(d.moved([flaky]), [], 'first sight');
  assert.deepEqual(d.moved([flaky]), [], 'unreadable');
  assert.deepEqual(d.moved([flaky]), [], 'back, unchanged');
  assert.deepEqual(d.moved([flaky]), ['flaky'], 'genuinely changed');
});

await check('a workspace that only becomes readable later is not a change', () => {
  const marks = [null, null, 'x', 'x'];
  const d = createChangeDetector({ mark: () => marks.shift() });
  const ws = { name: 'late' };
  assert.deepEqual(d.moved([ws]), []);
  assert.deepEqual(d.moved([ws]), []);
  assert.deepEqual(d.moved([ws]), [], 'the first readable mark is a baseline, not news');
  assert.deepEqual(d.moved([ws]), []);
});

/* ------------------------------------------------------------------- the fast clock */

await check('five seconds by default, and it is milliseconds', () => {
  assert.equal(detectIntervalMs({}), 5000);
  assert.equal(detectIntervalMs({ pollSeconds: 30 }), 5000);
});

await check('setting it to pollSeconds is how the whole mechanism is turned off', () => {
  assert.equal(detectIntervalMs({ pollSeconds: 30, detectSeconds: 30 }), 30_000);
});

await check('it can never beat slower than the sweep it is in front of', () => {
  assert.equal(detectIntervalMs({ pollSeconds: 10, detectSeconds: 60 }), 10_000);
  // pollSeconds has a floor of 5 of its own, and the ceiling follows it there.
  assert.equal(detectIntervalMs({ pollSeconds: 1, detectSeconds: 60 }), 5000);
});

await check('nonsense falls back rather than making a timer of it', () => {
  assert.equal(detectIntervalMs({ detectSeconds: 0 }), 5000);
  assert.equal(detectIntervalMs({ detectSeconds: -1 }), 5000);
  assert.equal(detectIntervalMs({ detectSeconds: 'soon' }), 5000);
  assert.equal(detectIntervalMs({ detectSeconds: 0.2 }), 1000, 'floored at a second');
});

/* ------------------------------------------------------- and the cycle actually uses it */

const { startPoller } = await import(LIB('server.js'));

/**
 * A poller with a real workspace directory under it and everything else faked.
 *
 * `pollSeconds` is deliberately enormous: the backstop must never be what makes these
 * assertions pass, so the *only* thing that can cause a second sweep here is the
 * detector noticing the manifest move.
 */
const drivePoller = async (over = {}) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'poll-'));
  const beads = path.join(dir, '.beads');
  const manifest = path.join(beads, 'embeddeddolt', 'pl', '.dolt', 'noms', 'manifest');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, 'poll-one');

  let sweeps = 0;
  let advocateTicks = 0;
  const timer = startPoller(
    {
      baseUrl: 'http://127.0.0.1',
      token: 'detect-token',
      actor: 'beadcause-test',
      workspaces: [{ name: 'pl', dir: beads }],
      pollSeconds: 3600,
      detectSeconds: 1,
      autoDispatch: false,
      ntfy: { enabled: false },
      ...over,
    },
    {
      bus: { emit() {} },
      hooks: {},
      bd: { comments: async () => [], removeLabel: async () => {} },
      advocates: {
        tick: async () => {
          advocateTicks += 1;
        },
      },
      allQuestions: async () => {
        sweeps += 1;
        return [];
      },
    }
  );
  return { manifest, timer, counts: () => ({ sweeps, advocateTicks }) };
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

await check('a tracker that moves is swept without waiting for pollSeconds', async () => {
  const run = await drivePoller();
  try {
    await settle(150);
    const first = run.counts().sweeps;
    assert.equal(first, 1, 'the poller sweeps once on the way up');
    fs.writeFileSync(run.manifest, 'poll-two');
    await settle(1400);
    assert.equal(run.counts().sweeps, 2, 'the move was not noticed within a beat');
  } finally {
    clearInterval(run.timer);
  }
});

await check('a quiet tracker costs nothing at all — no sweep, whatever the beat', async () => {
  const run = await drivePoller();
  try {
    await settle(2400);
    assert.equal(run.counts().sweeps, 1, 'an idle daemon swept more than once in two beats');
  } finally {
    clearInterval(run.timer);
  }
});

await check('the slow sweeps stay on the slow clock however often the fast one beats', async () => {
  const run = await drivePoller();
  try {
    await settle(150);
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(run.manifest, `poll-${i}`);
      await settle(1100);
    }
    const { sweeps, advocateTicks } = run.counts();
    assert.ok(sweeps >= 3, `the moves were noticed (${sweeps} sweeps)`);
    assert.equal(advocateTicks, 1, 'the advocate tick rode the fast clock');
  } finally {
    clearInterval(run.timer);
  }
});

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
