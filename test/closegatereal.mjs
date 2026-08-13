#!/usr/bin/env node
/**
 * `Bd.gateFor` against the binary it is a model of — does bd actually refuse these?
 *
 *     npm test
 *     node test/closegatereal.mjs
 *
 * test/closegate.mjs proves the gate answers the way lib/bd.js believes bd behaves.
 * It cannot prove that belief is *true*: its `bd` is a stub, and a stub can only ever
 * confirm what the code already thinks. So the two failures that file names as
 * expensive — missing a gate, and inventing one — are both invisible to it. Inventing
 * one is the silent kind: a question bd would close perfectly happily becomes
 * unanswerable from the phone, and nothing anywhere says why.
 *
 * bc-5864 was filed believing that had happened, on evidence that looked conclusive:
 * bc-rk2o closed by bin/deliver.js at a moment its child bc-rk2o.1 was still open, so
 * bd had apparently permitted a close the gate would have refused. It had not. bc-rk2o
 * is a **feature**, and bd's parent gate is on the word `epic` alone — a feature, task,
 * bug or chore closes over as many open children as it likes. The gate agrees, because
 * `gateFor` asks about children only for `issue_type === 'epic'`. Both were right and
 * the evidence was misread, which is a thing a fixture cannot tell you and this file
 * can. Hence: same shapes, real workspace, and every case asserts the gate's answer
 * **and** what the binary then does with the same close.
 *
 * It is the slow one of the pair — a `bd init` and ~30 invocations of a real tracker,
 * against embedded Dolt — and that is the price of asking rather than assuming. Nothing
 * it touches is shared: the workspace is a fresh mkdtemp, so it neither takes the Dolt
 * write lock any other session is waiting on nor cares who else is running.
 *
 * Skipped, loudly, where `bd` is not installed — same as test/attribution.mjs. A machine
 * without the tracker cannot answer the question, and failing there would say something
 * untrue about the code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Bd } = await import(path.join(HERE, '..', 'lib', 'bd.js'));

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nthe close gate, against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it refuses cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-closegatereal-'));
const dir = path.join(tmp, '.beads');
fs.mkdirSync(dir, { recursive: true });

// Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
// shell's cwd, so a shell here would resolve to somebody's actual tracker and this
// file *closes things*. Same reason lib/bd.js uses execFile — see the note atop it.
const env = { ...process.env, BEADS_DIR: dir };
const bdRun = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });

const init = bdRun(['init', '--skip-agents', '--prefix', 'cg']);
if (init.status !== 0) {
  bad('a temp workspace can be made to ask in', (init.stderr || init.stdout || '').split('\n')[0]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures}/${ran} failed\n`);
  process.exit(1);
}

const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const ws = { name: 'closegatereal', dir };
const make = (over = {}) =>
  bd.create(ws, { title: 'a bead', body: 'x', priority: 2, type: 'task', labels: [], ...over });

/**
 * One case, asked twice: what the gate says, and what the binary then does.
 *
 * The close is attempted for real, which is why every case gets its own beads —
 * a permitted close mutates the workspace, and a second case reading the same
 * rows would be reading the first case's aftermath.
 *
 * `refused` is what the case claims, and both halves are asserted against it, so a
 * gate that drifted in *either* direction fails here: over-gating shows up as the
 * binary closing something the gate held, under-gating as the binary refusing
 * something the gate waved through.
 */
async function agree(name, id, refused, { reason = null } = {}) {
  const gate = await bd.closeGate(ws, id);
  const closed = bdRun(['close', id, '--reason', 'asking bd']);
  const said = `${closed.stderr || ''}${closed.stdout || ''}`.trim().split('\n')[0];

  check(() => assert.equal(Boolean(gate), refused, `gate: ${JSON.stringify(gate)}`), `${name} — the gate ${refused ? 'refuses' : 'permits'} it`);
  check(
    () => assert.equal(closed.status !== 0, refused, `bd said: ${said}`),
    `${name} — and bd ${refused ? 'refuses' : 'permits'} the same close`
  );
  if (reason && gate) check(() => assert.match(said, reason), `${name} — for the reason the gate names`);
  return said;
}

/* ------------------------------------------------------- an epic, which is gated */

{
  const epic = await make({ type: 'epic', title: 'an epic with a child still open' });
  await make({ type: 'task', parent: epic, title: 'the open child' });
  await agree('an epic with an open child', epic, true, { reason: /open child/i });
}

{
  // The child bc-5864 pointed at was `in_progress`, not `open`, and that is the state
  // a child is in while a worker session has it — so if any status slipped through
  // bd's count it would be this one, on exactly the beads a delivery closes over.
  const epic = await make({ type: 'epic', title: 'an epic whose child is being worked' });
  const child = await make({ type: 'task', parent: epic, title: 'the in-progress child' });
  await bd.run(ws, ['update', child, '--status=in_progress']);
  await agree('an epic whose child is in_progress', epic, true, { reason: /open child/i });
}

{
  // Deferred reads as "not now" everywhere else in this app, and it is easy to assume
  // bd treats it as settled. It does not — and neither does `gateFor`, which counts
  // every child that is not `closed`.
  const epic = await make({ type: 'epic', title: 'an epic whose child is deferred' });
  const child = await make({ type: 'task', parent: epic, title: 'the deferred child' });
  await bd.run(ws, ['defer', child, '--until=2099-01-01']);
  await agree('an epic whose child is deferred', epic, true, { reason: /open child/i });
}

{
  const epic = await make({ type: 'epic', title: 'an epic that is actually finished' });
  const child = await make({ type: 'task', parent: epic, title: 'the child that landed' });
  await bd.close(ws, child, 'done');
  await agree('an epic whose children have all closed', epic, false);
}

{
  const epic = await make({ type: 'epic', title: 'an epic with nothing under it' });
  await agree('an epic with no children at all', epic, false);
}

/* ------------------------------------- a parent that is not an epic, which is not */

{
  // **The bc-5864 case.** bc-rk2o was a feature with five children and bin/deliver.js
  // closed it over an open one; that read as bd contradicting the gate, and it is bd
  // being consistent with it. Both stop at the word `epic`. If bd ever widens the rule
  // to any parent, this is the assertion that says so — and the day it fails, `gateFor`
  // is under-gating and answers from the phone start throwing again.
  const feature = await make({ type: 'feature', title: 'a feature with a child still open' });
  await make({ type: 'task', parent: feature, title: 'the open child of a feature' });
  await agree('a feature with an open child', feature, false);
}

{
  const parent = await make({ type: 'task', title: 'a task with a subtask still open' });
  await make({ type: 'task', parent, title: 'the open subtask' });
  await agree('a task with an open subtask', parent, false);
}

/* -------------------------------------------------------- blockers, which are gated */

{
  const blocked = await make({ title: 'a bead behind an open blocker' });
  const blocker = await make({ title: 'the blocker' });
  await bd.addDep(ws, blocked, blocker);
  await agree('a bead blocked by an open issue', blocked, true, { reason: /blocked by open issues/i });
}

{
  // A deferred blocker is the same surprise as a deferred child, one gate over.
  const blocked = await make({ title: 'a bead behind a deferred blocker' });
  const blocker = await make({ title: 'the deferred blocker' });
  await bd.addDep(ws, blocked, blocker);
  await bd.run(ws, ['defer', blocker, '--until=2099-01-01']);
  await agree('a bead blocked by a deferred issue', blocked, true, { reason: /blocked by open issues/i });
}

{
  const blocked = await make({ title: 'a bead whose blocker landed' });
  const blocker = await make({ title: 'the blocker that closed' });
  await bd.addDep(ws, blocked, blocker);
  await bd.close(ws, blocker, 'done');
  await agree('a bead whose blocker has closed', blocked, false);
}

{
  // Every bead this app files from another carries a `discovered-from` edge, and they
  // arrive in `dependencies` looking exactly like a blocker bar the type. Gating on
  // them would make every agent-filed bead unanswerable.
  const found = await make({ title: 'a bead found while working another' });
  const source = await make({ title: 'the bead it was found from' });
  await bd.run(ws, ['dep', 'add', found, source, '--type', 'discovered-from']);
  await agree('a bead with only a discovered-from edge', found, false);
}

/* ---------------------------------- and the shape the gate does not model at all */

{
  // Not a gate, and worth pinning as *not* one: a blocker can close while the thing it
  // blocks is still open. If that ever became a refusal, `Bd.dropDep` — which a merge
  // uses to get a work bead out from behind its own card — would be answering the wrong
  // question, and nothing else here would notice.
  const blocked = await make({ title: 'still open, still blocked' });
  const blocker = await make({ title: 'a blocker being closed first' });
  await bd.addDep(ws, blocked, blocker);
  await agree('a blocker closing while what it blocks stays open', blocker, false);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
