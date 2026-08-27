#!/usr/bin/env node
//
// How much of this Mac a gate is allowed to take — bc-xlz32.1 and bc-xlz32.5.
//
//   node test/gateslots.mjs
//
// Two halves of one budget. `acquireSlot` caps how many gates run at once; `chooseJobs`
// picks how many suites one gate runs. lib/gate.js carries both so they can be driven
// directly here, against a slot directory this suite owns, rather than by starting real
// gates and watching the load average — which is the measurement that made the bead, and
// is not a test.
//
// The three properties worth proving are the three that were wrong before: that a third
// gate WAITS rather than being refused (a refused session runs `node scripts/test.mjs`
// instead, which is worse than the problem), that a holder killed with SIGKILL frees its
// slot rather than wedging the machine forever, and that a runner started INSIDE a gate
// never queues behind the slot its own parent is holding.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const gate = await import(path.join(ROOT, 'lib', 'gate.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-gateslots-'));
/**
 * Every acquire in this file is pointed under `tmp`, so nothing touches the real Mac-wide
 * one — and each check gets a semaphore of its own, because a check that fails leaves its
 * slots held and its pending acquire pending. Sharing one directory meant the next check
 * waited on a slot nothing would ever free, so a one-line assertion failure came back as
 * the whole suite timing out at 300s, which is what this red actually looked like in CI.
 */
const room = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

console.log('\nhow many gates at once\n');

await checkAsync('the first two hold slots and the third does not', async () => {
  const base = room('two-at-once');
  const first = await gate.acquireSlot({ base, limit: 2, pid: process.pid, pollMs: 5 });
  const second = await gate.acquireSlot({ base, limit: 2, pid: process.pid, pollMs: 5 });
  assert.equal(first.held, true, 'first should hold');
  assert.equal(second.held, true, 'second should hold');
  assert.equal(gate.liveSlots(base).length, 2);

  let waited = 0;
  const third = gate.acquireSlot({
    base,
    limit: 2,
    pid: process.pid,
    pollMs: 5,
    onWait: () => (waited += 1),
  });
  // It must still be waiting, not refused and not resolved — give it real polls to prove it.
  const race = await Promise.race([third, new Promise((r) => setTimeout(() => r('still waiting'), 120))]);
  assert.equal(race, 'still waiting', 'the third gate should queue, not run');
  assert.ok(waited > 0, 'a waiting gate should be told what it is waiting for');

  // …and take the slot the moment one is free, rather than needing to be started again.
  first.release();
  const got = await third;
  assert.equal(got.held, true);
  assert.ok(got.waitedMs >= 0);
  second.release();
  got.release();
  assert.equal(gate.liveSlots(base).length, 0, 'released slots leave nothing behind');
});

await checkAsync('a gate arriving later never sorts ahead of one already holding', async () => {
  // The bug that made this suite red on main, and it is not only a suite: the queue orders
  // by `startedAt`, and `Date.now()` is a whole millisecond, so tickets taken back-to-back
  // all landed inside one. Equal stamps fell through to the random suffix in each ticket's
  // filename, and the newcomer sorted first about two times in three — taking a slot two
  // gates ahead of it were already holding, which is `limit + 1` gates on the Mac at once.
  // Sub-millisecond stamps are what make the order creation order, so assert exactly that.
  const base = room('never-overtake');
  const taken = [];
  for (let i = 0; i < 6; i += 1) {
    taken.push(await gate.acquireSlot({ base, limit: 6, pid: process.pid, pollMs: 5 }));
  }
  const stamps = gate.liveSlots(base).map((t) => t.startedAt);
  assert.equal(stamps.length, 6);
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] > stamps[i - 1], `ticket ${i} must sort after ${i - 1} — ${stamps.join(', ')}`);
  }
  taken.forEach((t) => t.release());
});

await checkAsync('a queue is FIFO — the gate that waited longest goes first', async () => {
  const base = room('fifo');
  const holder = await gate.acquireSlot({ base, limit: 1, pid: process.pid, pollMs: 5 });
  const early = gate.acquireSlot({ base, limit: 1, pid: process.pid, pollMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  const late = gate.acquireSlot({ base, limit: 1, pid: process.pid, pollMs: 5 });
  await new Promise((r) => setTimeout(r, 20));

  holder.release();
  const first = await early;
  const stillWaiting = await Promise.race([late, new Promise((r) => setTimeout(() => r('waiting'), 60))]);
  assert.equal(stillWaiting, 'waiting', 'the later gate must not overtake the earlier one');
  first.release();
  (await late).release();
});

await checkAsync('a holder killed with SIGKILL frees its slot', async () => {
  const base = room('sigkill');
  const script = path.join(tmp, 'holder.mjs');
  fs.writeFileSync(
    script,
    `import { acquireSlot } from ${JSON.stringify(path.join(ROOT, 'lib', 'gate.js'))};\n` +
      `await acquireSlot({ base: ${JSON.stringify(base)}, limit: 1, pollMs: 5 });\n` +
      `console.log('held');\n` +
      `await new Promise(() => {});\n`,
  );
  const holder = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', (d) => String(d).includes('held') && resolve());
    holder.on('error', reject);
    setTimeout(() => reject(new Error('the holder never took its slot')), 10_000);
  });
  assert.equal(gate.liveSlots(base).length, 1, 'the child should be holding one');

  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('close', resolve));

  // Nothing ran a cleanup — the ticket file is still on disk, and its pid is not.
  assert.equal(fs.readdirSync(gate.slotDir(base)).filter((f) => f.endsWith('.json')).length, 1);
  const mine = await gate.acquireSlot({ base, limit: 1, pollMs: 5 });
  assert.equal(mine.held, true, 'a dead holder must not wedge the machine');
  mine.release();
});

console.log('\nthe three runs that must never queue\n');

check('a runner inside a gate does not take a second slot', () => {
  assert.equal(gate.slotLimit({ [gate.HELD_ENV]: '1' }), 0);
  // …and that is the variable both runners actually set on every suite child.
  const runners = ['lib/gate.js', 'scripts/test.mjs'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const [i, src] of runners.entries()) {
    assert.match(src, /\[HELD_ENV\]: '1'/, `${['lib/gate.js', 'scripts/test.mjs'][i]} must mark its suite children`);
  }
});

check('CI never queues behind this Mac', () => {
  assert.equal(gate.slotLimit({ CI: 'true' }), 0);
});

check('the opt-out is a number, and a nonsense one falls back rather than disabling', () => {
  assert.equal(gate.slotLimit({ BEADCAUSE_GATE_SLOTS: '0' }), 0);
  assert.equal(gate.slotLimit({ BEADCAUSE_GATE_SLOTS: '4' }), 4);
  assert.equal(gate.slotLimit({ BEADCAUSE_GATE_SLOTS: 'yes' }), gate.DEFAULT_SLOTS);
  assert.equal(gate.slotLimit({}), gate.DEFAULT_SLOTS);
});

await checkAsync('a disabled semaphore is a no-op that still answers, and writes nothing', async () => {
  const off = path.join(tmp, 'off');
  const slot = await gate.acquireSlot({ base: off, limit: 0 });
  assert.equal(slot.held, false);
  slot.release();
  assert.equal(fs.existsSync(gate.slotDir(off)), false, 'nothing to take means nothing to create');
});

check('a waiting gate says what it is waiting for, and how long it has been', () => {
  const now = 10 * 60_000;
  const line = gate.waitingLine({ ahead: 2, oldest: { startedAt: now - 4 * 60_000 } }, now);
  assert.match(line, /2 gates ahead of you/);
  assert.match(line, /4m ago/);
  assert.match(gate.waitingLine({ ahead: 1, oldest: { startedAt: now } }, now), /1 gate ahead of you/);
  assert.match(gate.waitingLine({ ahead: 1 }, now), /waiting/);
});

console.log('\nhow many suites at once\n');

check('an idle Mac gets most of itself, not six', () => {
  assert.equal(gate.chooseJobs({ cores: 12, load: 0.2 }), 10);
  assert.equal(gate.chooseJobs({ cores: 12, load: 1.5 }), 10);
});

check('a busy Mac gets what is actually free', () => {
  assert.equal(gate.chooseJobs({ cores: 12, load: 6 }), 6);
  assert.equal(gate.chooseJobs({ cores: 12, load: 9 }), 3);
});

check('a hopeless Mac still moves, and never asks for less than two', () => {
  assert.equal(gate.chooseJobs({ cores: 12, load: 99 }), 2);
  assert.equal(gate.chooseJobs({ cores: 2, load: 0 }), 2);
  assert.equal(gate.chooseJobs({ cores: 1, load: 0 }), 2);
});

check('the machine is left something to be usable with', () => {
  for (const cores of [4, 8, 12, 16]) {
    assert.ok(gate.chooseJobs({ cores, load: 0 }) <= Math.max(2, cores - 2), `${cores} cores`);
  }
});

check('the chosen number is said out loud, and an explicit ask says so instead', () => {
  assert.match(gate.jobsLine({ jobs: 10, cores: 12, load: 1.44, explicit: false }), /10 suites at once/);
  assert.match(gate.jobsLine({ jobs: 10, cores: 12, load: 1.44, explicit: false }), /12 cores, load 1\.4/);
  assert.equal(gate.jobsLine({ jobs: 4, cores: 12, load: 1.4, explicit: true }), '4 suites at once, as asked');
});

check('--jobs given still wins outright, the rule --timeout already follows', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'b7e-gate'), 'utf8');
  assert.match(cli, /JOBS_EXPLICIT \?/, 'an explicit --jobs must bypass chooseJobs entirely');
});

removeTreeSync(tmp);

console.log(
  failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mgate slots and job sizing hold\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
