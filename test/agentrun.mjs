#!/usr/bin/env node
//
// The shared runner behind both headless daemon agents — `lib/agentrun.js`.
//
//   npm test                    (runs it alongside the other suites)
//   node test/agentrun.mjs      (on its own)
//
// bc-dgx7.8. lib/jiraingest.js's runner and lib/sessionaudit.js's runner were the same
// spawn-and-parse, and both dropped every `stream-json` event but the last on the floor —
// so a run either of them made existed nowhere once the process exited. This is the
// runner they now share, and what is worth a suite is exactly the two things a copy of
// the old code would not have given them for free:
//
// 1. **Every event lands on `lib/agentlog.js` under `key`**, not only the final answer —
//    the gap the bead names, read back from the *archive* rather than the live file,
//    because the live file is gone by the time a caller could look (see 2).
// 2. **The run reaches `refs/beadcause/agentlogs` when it ends**, success, failure or
//    timeout alike — not when some future run at the same key happens to start, which is
//    how lib/dispatch.js and the advocate's survey do it and which neither headless agent
//    can rely on: a JIRA ticket ingests once, and a quiet checkout may never audit again.
//
// A fake `spawnImpl` stands in for `claude` throughout — a real `claude -p` is exactly
// the thing beadcause's own suites cannot drive, and every caller here already injects
// this runner's `run` for the same reason. Everything runs against a temp
// `BEADCAUSE_CONFIG_DIR` and a temp git repo; nothing here touches ~/.config/beadcause,
// this checkout's refs, or the network.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupTmp } from './helpers/tmp.mjs';

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
};

const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-agentrun-'));
process.env.BEADCAUSE_CONFIG_DIR = CONFIG;

const { runHeadless } = await import('../lib/agentrun.js');
const agentlog = await import('../lib/agentlog.js');
const archive = await import('../lib/agentarchive.js');

/** A git repo of its own, so the chain is never written into this checkout. */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-agentrun-repo-'));
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);

/* ------------------------------------------------------------------ the fake process */

/** A node:child_process ChildProcess, just enough of one for runHeadless to drive. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = (sig) => {
    child.killed = true;
    // A real SIGTERM ends the process; the test drives that itself by emitting 'close'.
    child.emit('__kill__', sig);
  };
  return child;
}

/** Spawns nothing; hands back a fake and remembers how it was called. */
function spawner() {
  const calls = [];
  let child = null;
  return {
    calls,
    child: () => child,
    impl: (cmd, args, opts) => {
      child = fakeChild();
      calls.push({ cmd, args, opts });
      return child;
    },
  };
}

/** The stream-json lines a real `claude -p` run would have written, one per line. */
const line = (event) => `${JSON.stringify(event)}\n`;
const resultEvent = (text, extra = {}) => ({ type: 'result', result: text, is_error: false, ...extra });
const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

/**
 * Wait until the fake spawn has actually been called.
 *
 * `effective()` awaits first, and it gets there through a real `git` subprocess (a
 * `rev-parse` and a ref read) — a `setImmediate` loop burns through hundreds of ticks in
 * well under a millisecond of wall clock, nowhere near long enough for that subprocess to
 * come back, so this polls on a real timer instead. Ten seconds is generous for a `git`
 * call against a two-commit temp repo; it is not generous enough to hide a real hang.
 */
async function waitForChild(get, { timeoutMs = 10000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!get() && Date.now() < deadline) await new Promise((r) => setTimeout(r, stepMs));
  if (!get()) throw new Error('spawnImpl was never called');
  return get();
}

/* -------------------------------------------------------- 1. every event, not just the last */

await check('every stream-json event lands under `key`, not only the final result', async () => {
  const key = 'beadcause/run-events';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: { cwd: repo, agent: 'test-agent', model: 'test-model' },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(assistantText('reading the ticket')));
  child.stdout.emit('data', line(resultEvent('the final answer')));
  child.emit('close', 0, null);
  const answer = await p;
  assert.equal(answer, 'the final answer');

  // The live pane is gone by now — archiveAndReset cleared it the moment the run ended —
  // so what it held is read back off the chain, which is exactly the property under test.
  assert.equal(fs.existsSync(agentlog.logPath(key)), false, 'the live log was not cleared');
  const runs = await archive.runs({ cwd: repo, key });
  assert.equal(runs.length, 1, 'the run did not reach the chain');
  const body = archive.readBody(runs[0].id);
  assert.match(body, /reading the ticket/, 'an event other than the final result was dropped');
  assert.match(body, /done/, 'the result event itself was dropped');
});

/* --------------------------------------------------------------- 2. archived when it ends */

await check('a run with no key never reaches archived at all', async () => {
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key: null,
    meta: { cwd: repo },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(resultEvent('fine')));
  child.emit('close', 0, null);
  assert.equal(await p, 'fine');
  // Nothing to assert against a key that was never given — the check is that nothing
  // above threw, which a `key`-shaped bug (e.g. `undefined` slugged into a filename)
  // would have.
});

await check('a failed run is archived too — the run an incident wants is the one that failed', async () => {
  const key = 'beadcause/run-failed';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: { cwd: repo, agent: 'test-agent' },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(assistantText('about to fall over')));
  child.stderr.emit('data', 'boom\n');
  child.emit('close', 1, null);
  await assert.rejects(p, /claude exited 1/);

  const runs = await archive.runs({ cwd: repo, key });
  assert.equal(runs.length, 1, 'a failed run did not reach the chain');
  assert.match(archive.readBody(runs[0].id), /about to fall over/);
});

await check('a timed-out run is archived under whatever it managed to write', async () => {
  const key = 'beadcause/run-timeout';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: { cwd: repo, agent: 'test-agent' },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(assistantText('reading forever')));
  // A real timeout fires `child.kill('SIGTERM')`, which a real process manager answers
  // with exactly this close — driven directly, rather than through the console
  // foundation's own (much longer) `timeoutMs`, which this call has no reason to amend.
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(p, /timed out/);

  const runs = await archive.runs({ cwd: repo, key });
  assert.equal(runs.length, 1, 'a timed-out run did not reach the chain');
  assert.match(archive.readBody(runs[0].id), /reading forever/);
});

/* ------------------------------------------------------------------- 3. provenance */

await check('the archived record carries the provenance the caller handed in', async () => {
  // Ending in `/bc-ep1`, the way lib/dispatch.js's own key ends in `/<bead>` — `runs()`
  // finds a bead by grepping the commit *subject*, which carries the key rather than the
  // bead field on its own, so a key that does not end in the bead is a bead nothing here
  // would ever find (this is why lib/jiraingest.js's key is `<workspace>/<epic id>`, one
  // epic per ticket, rather than `<workspace>/<ticket key>`).
  const key = 'beadcause/bc-ep1';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: {
      cwd: repo,
      workspace: 'climative',
      bead: 'bc-ep1',
      agent: 'jira-ingest',
      model: 'a-model-nothing-here-would-derive',
      endorsed: false,
      endorsementNote: 'held like the epic',
    },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(resultEvent('ok')));
  child.emit('close', 0, null);
  await p;

  const runs = await archive.runs({ cwd: repo, bead: 'bc-ep1' });
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.workspace, 'climative');
  assert.equal(run.agent, 'jira-ingest');
  assert.equal(run.model, 'a-model-nothing-here-would-derive');
  assert.equal(run.endorsement.endorsed, false);
  assert.equal(run.endorsement.note, 'held like the epic');
});

await check('a caller with nothing to say gets `null` rather than a guess', async () => {
  // The console baseline's own `model` is `null` until `withConfig` or a route picks
  // one — neither runs here — so the honest fallback is null, the same as the advocate
  // survey's `model: f.model || null` already accepts. Recording a guessed model would
  // be worse than recording none: `agentarchive.js`'s own header is explicit that
  // provenance is taken, never re-derived.
  const key = 'beadcause/run-no-model';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: { cwd: repo },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', line(resultEvent('ok')));
  child.emit('close', 0, null);
  await p;

  const runs = await archive.runs({ cwd: repo, key });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].model, null);
});

/* -------------------------------------------------------------- 4. lines that are not JSON */

await check('a non-JSON stdout line is kept as-is rather than dropped', async () => {
  const key = 'beadcause/run-nonjson';
  const sp = spawner();
  const p = runHeadless({
    dir: repo,
    prompt: 'do the thing',
    systemText: 'be helpful',
    key,
    meta: { cwd: repo },
    spawnImpl: sp.impl,
  });
  const child = await waitForChild(sp.child);
  child.stdout.emit('data', 'zsh: command not found: claude\n');
  child.emit('close', 127, null);
  await assert.rejects(p);

  const runs = await archive.runs({ cwd: repo, key });
  assert.equal(runs.length, 1);
  assert.match(archive.readBody(runs[0].id), /command not found/);
});

/* ---------------------------------------------------------------------- summary */

await cleanupTmp(CONFIG);
fs.rmSync(repo, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
