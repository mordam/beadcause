/**
 * Nothing may open a second window on a bead a live window already has — bc-7qo.19.
 *
 * The incident: three live `claude` processes carrying the identical worker brief for
 * bc-7qo.11 at 10:56Z on 2026-08-21, in three worktrees, two of them editing
 * lib/server.js at the same minute — while the daemon reported "at its limit of 2
 * session(s)" and `advocates.json` held one worker row for the bead. None of the three
 * was dispatched: their windows had been torn down mid-turn hours earlier and their
 * *shells* survived and re-ran the command, which passes through none of the daemon's
 * counters.
 *
 * Two halves, matching the two layers, and they are the same two lib/stillopen.js has:
 *
 * 1. **The refusal**, at the doors this daemon owns — `openWorkSession`,
 *    `resumeWorkSession` and `openPlanSession`. Asserted through the door rather than
 *    only against `assertNoOtherWindow`, because the failure this file exists to catch
 *    is somebody adding a fifth door and not the gate itself going wrong.
 * 2. **The sentence in the brief**, in `workPromptFor` — because the refusal only covers
 *    the doors, and the window that re-ran its own command came through none of them.
 *
 * The process table is injected in the shape lib/claude.js already takes it, so both
 * sides are driven without a real `ps` and without a second window anywhere near this
 * Mac. The pid in the fixtures is this process's own, because `liveProcessLines` drops
 * any row whose pid is not alive — a fabricated 111 would be filtered out before the
 * match, and the test would pass for the wrong reason.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-onewindow-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { assertNoOtherWindow, refusal } = await import(LIB('onewindow.js'));
const { openWorkSession, openPlanSession, workPromptFor, selfExcluding } = await import(LIB('session.js'));

const ws = { name: 'demo', dir: tmp };
const cfg = { sessionDirs: { demo: tmp }, openSessions: true };

/** A tracker that answers `show` with one open row, and is asked nothing else. */
const trackerSaying = (row) => ({ show: async () => row });
const openRow = (id) => ({ id, title: 'a bead', status: 'open', labels: [] });

/**
 * A process table with one window on `<workspace>/<id>`, in the shape a real brief's argv
 * has — the first line of every worker prompt, which is what puts the qualified id there.
 */
const psWith = (...ids) => async () =>
  ids
    .map(
      (id) =>
        `  ${process.pid} /usr/bin/claude --permission-mode auto -- You are working bead **${id}**, opened automatically`
    )
    .join('\n');

/** And one with nothing on it at all. */
const psEmpty = async () => '';

/* --------------------------------------------------------------------- harness */

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

console.log('\nnothing may open a second window on a bead a live window already has\n');

/* ---------------------------------------------------------------- the gate itself */

await check('the gate refuses when a live process already names the qualified bead', async () => {
  await assert.rejects(
    () => assertNoOtherWindow('demo', 'zz-1', { ps: psWith('demo/zz-1') }),
    (err) => err.status === 409 && err.occupied === true && err.pids.includes(process.pid),
    'a caller can tell this from a launch that failed, and must not retry it'
  );
});

await check('and passes when nothing does', async () => {
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1', { ps: psEmpty }), []);
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1', { ps: psWith('demo/zz-2') }), [], 'a neighbour is not it');
});

await check('the match is workspace-qualified — a bare id in prose is not a window', async () => {
  // The false positive that cost test/epicqueue.mjs a run: a brief carries its whole
  // memory store, and a memory note quotes bead ids as examples. `linesNameBead` matches
  // `<workspace>/<id>` for exactly this reason and this is the guard on it.
  const prose = async () =>
    `  ${process.pid} /usr/bin/claude -- a memory note that mentions zz-1 and other/zz-1 in passing`;
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1', { ps: prose }), []);
});

await check('a subtask is not its parent, and a parent is not its subtask', async () => {
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1', { ps: psWith('demo/zz-1.2') }), [], 'zz-1.2 is not zz-1');
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1.2', { ps: psWith('demo/zz-1') }), [], 'nor the reverse');
});

await check('a process table that cannot be read leaves the launch alone', async () => {
  // Best-effort by design: the queue filter is the belt, and stopping the whole fleet on
  // an unreadable `ps` is a worse failure than the one this guards.
  const broken = async () => {
    throw new Error('ps: no');
  };
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1', { ps: broken }), []);
});

await check('with no injected table, a process that may not launch asks nothing', async () => {
  // A suite cannot put a second window on a bead because it cannot put a first one there,
  // and a `ps` per gate in every suite that touches this door would be paid for nothing.
  // Driven through the real default rather than a flag: this file *is* such a process.
  assert.deepEqual(await assertNoOtherWindow('demo', 'zz-1'), []);
});

await check('the refusal names the pids, because that is what a reader has to go on', () => {
  const err = refusal('zz-1', [4242, 4243]);
  assert.equal(err.status, 409);
  assert.equal(err.occupied, true);
  assert.match(err.message, /2 live window\(s\) already name it/);
  assert.match(err.message, /pid 4242, 4243/);
});

/* ------------------------------------------------------------------ the doors */

/**
 * Through the door, both ways round. The negative case is the one that proves the wiring:
 * a launch that gets *past* this gate is then refused by `assertMayLaunch` with a
 * different named boolean, so "occupied" and "the suite may not open a window" cannot be
 * confused for each other, and deleting the call site turns the first check red rather
 * than leaving both green.
 */
for (const [name, open] of [
  ['openWorkSession', (extra) => openWorkSession(cfg, ws, openRow('zz-1'), extra)],
  ['openPlanSession', (extra) => openPlanSession(cfg, ws, openRow('zz-1'), extra)],
]) {
  await check(`${name} refuses a bead a live window already names`, async () => {
    await assert.rejects(
      () => open({ bd: trackerSaying(openRow('zz-1')), ps: psWith('demo/zz-1') }),
      (err) => err.status === 409 && err.occupied === true,
      'the queue filter is not the guarantee — the queue is not the only way in'
    );
  });

  await check(`${name} lets a bead nothing names through this gate`, async () => {
    await assert.rejects(
      () => open({ bd: trackerSaying(openRow('zz-1')), ps: psEmpty }),
      (err) => err.occupied !== true,
      'past the gate, and stopped by the one that stops every suite'
    );
  });
}

await check('a resumed conversation is refused too — the park record says nothing about now', async () => {
  await assert.rejects(
    () =>
      openWorkSession(cfg, ws, openRow('zz-1'), {
        bd: trackerSaying(openRow('zz-1')),
        ps: psWith('demo/zz-1'),
        resume: { rec: { dir: tmp, sessionId: 'abc' }, prompt: 'carry on' },
      }),
    (err) => err.status === 409 && err.occupied === true,
    'a window somebody re-opened by hand is exactly the case a park record cannot see'
  );
});

/* ------------------------------------------------------------------- the brief */

await check('the brief tells a window how to find out it is not the only one', async () => {
  const text = workPromptFor('demo', openRow('zz-1'), 1, null, 'Adam', {});
  assert.match(text, /ps -Ao pid=,args=/, 'the command that answers it, spelled out');
  assert.match(text, /dem\[o\]\/zz-1/, 'the qualified id, in a pattern that cannot match the command itself');
});

await check('and the pattern it gives cannot match the command line carrying it', () => {
  // The whole value of the check is that one window answers "1". `grep` finds its own
  // argv in the process table and so does the shell around the pipeline, so an unbracketed
  // pattern answers at least two on a Mac with one window open — and a window told to stop
  // at two would stop every time.
  assert.equal(selfExcluding('beadcause'), 'beadcaus[e]');
  assert.equal(selfExcluding('demo'), 'dem[o]');
  const pattern = new RegExp(`${selfExcluding('demo')}/zz-1`);
  assert.match('claude -- You are working bead **demo/zz-1**', pattern, 'it still finds a real window');
  assert.doesNotMatch(`ps -Ao pid=,args= | grep '${selfExcluding('demo')}/zz-1'`, pattern, 'and not itself');
  // A one-character workspace is left alone: `[d]` on its own is a pattern matching `d`,
  // which would be the same string back with brackets that do nothing.
  assert.equal(selfExcluding('d'), 'd');
  assert.equal(selfExcluding(''), '');
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
