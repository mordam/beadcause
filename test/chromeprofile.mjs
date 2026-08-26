#!/usr/bin/env node
/**
 * A finished browser check may not leave its throwaway profile behind.
 *
 *     npm test
 *     node test/chromeprofile.mjs
 *
 * `scripts/helpers/chrome.mjs` used to end a check with `proc.kill()` and, on the very
 * next line, `fs.rmSync(profile, { maxRetries: 3 })`. That is not a teardown, it is a
 * race with the thing it just signalled: `kill()` returns once the signal is *queued*,
 * and what it is queued for is a process tree whose renderer, GPU and crashpad children
 * go on writing into the profile for a moment after the browser process has taken it.
 *
 * **The losing shape is not an exception, which is the whole reason this is measured
 * rather than read.** `rmSync` walking a directory that is being repopulated behind it
 * either throws `ENOTEMPTY` or *succeeds against a directory that then comes back* — and
 * `maxRetries` does not cover the second one, because `maxRetries` is `rmSync`'s internal
 * retry of a failed unlink and that call did not fail. So the old code reported nothing,
 * every check exited 0, and the directories accumulated: measured on 2026-08-18, a
 * `gate-check.mjs` run that succeeded took TMPDIR from seven `beadcause-*` directories to
 * eight, the oldest of them from the previous morning (bc-5e85). A few hundred KB a run,
 * unbounded on a laptop that runs these all night.
 *
 * ## What is actually asserted, and why it needs a fake browser
 *
 * `npm test` does not have Chrome as a dependency and this is not the suite to make it
 * one — `test/chromeport.mjs` says the same thing and holds the line for the same reason.
 * But the bug is a *timing* bug against a process that keeps writing, and a suite that
 * launched the real Chrome would be measuring how fast this particular Mac happens to
 * shut a browser down, which is the definition of a flake.
 *
 * So the browser is a node child that does the one thing about Chrome this code cares
 * about: it writes into the profile directory continuously, and in one of the two
 * scenarios it declines to die of SIGTERM. That is stronger than the real thing, not
 * weaker — a stubborn writer is the worst case the escalation exists for, and it is
 * reproducible on any machine at any speed.
 *
 * **Every scenario is run past a control that must fail.** The same stubborn child is
 * torn down with the exact two lines the old code used, and the directory is asserted to
 * survive them. Without that, a green run here would prove only that the fake browser was
 * easy to kill, and this suite would go on passing on the day the fix was reverted.
 *
 * ## And it owns the directory it counts
 *
 * The acceptance is a count of TMPDIR before and against after, and taking that literally
 * is how `test/browse.mjs` was flaky for four separate bug reports: `/tmp` is shared by
 * every session on this laptop, so any other agent that opened a browser inside the window
 * failed the suite, over a directory that was gone again by the time anybody read the
 * diff. The counting here is therefore done against a sandbox directory this run made and
 * nobody else can see into — which is both what makes the count trustworthy and what stops
 * it disturbing anyone else's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import { killAndRemove, SIGKILL_AFTER_MS, TEARDOWN_TIMEOUT_MS } from '../scripts/helpers/chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, '..', 'scripts', 'helpers', 'chrome.mjs');

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

console.log('\nchrome profile teardown\n');

/* ------------------------------------------------------------- the fake browser */

/**
 * A child that behaves like the half of Chrome this teardown has to survive.
 *
 * It writes into the profile every couple of milliseconds, so a `rmSync` racing it is
 * racing a real writer rather than a hypothesis, and it recreates the directory as well
 * as the files in it — because that is the failure the old code actually had, a delete
 * that reported success against a path that came back.
 *
 * `stubborn` registers an empty SIGTERM handler, which replaces node's default action.
 * That is the Chrome that has to be escalated on; without it the child dies of the first
 * signal, which is the Chrome that does not.
 */
const CHILD = `
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = process.env.STUB_PROFILE;
  if (process.env.STUB_STUBBORN === '1') process.on('SIGTERM', () => {});
  let n = 0;
  setInterval(() => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f' + (n++ % 24)), 'x'.repeat(512));
    } catch { /* it was taken away mid-write; that is the point of the exercise */ }
  }, 2);
`;

/** Somewhere of our own to count, inside the real temp dir so the paths are realistic. */
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-profiletest-'));
const live = new Set();

/** Blocking, because everything else in this suite is; 25ms is a dozen of the child's writes. */
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const count = () => fs.readdirSync(sandbox).length;

/** Kill every stub and take the sandbox away. Both endings go through it. */
function cleanup() {
  for (const proc of live) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  settle(80);
  removeTreeSync(sandbox);
}

/**
 * A broken fixture, said once and then stopped on.
 *
 * Every scenario below needs a child that is *writing*; without one they all measure an
 * unattended directory and report on the teardown of nothing. That is worth one honest
 * red line rather than eleven misleading ones, so this ends the run where it is found.
 */
function fatal(name, detail) {
  bad(name, detail);
  cleanup();
  console.log(`\n\x1b[31m${ran - failures}/${ran}\x1b[0m assertions passed\n`);
  process.exit(1);
}

/** How long a `node -e` child gets to boot and reach its interval on a contended machine. */
const STUB_READY_TIMEOUT_MS = 10_000;

/**
 * Start one — and do not come back until it is demonstrably writing.
 *
 * Each call site used to follow this with `settle(120)`: a guess that a `node -e` child is
 * up and inside its interval within a tenth of a second. On an idle Mac it is. On a
 * machine running several suites at once — CI runs `bin/b7e-gate --jobs 3` on a 3-core
 * runner (bc-mrm77.1; it was `--jobs 4`, oversubscribed, when this suite inverted below),
 * and any concurrent local gate run is the same shape — it is not, and node has not
 * finished booting when the scenario starts measuring.
 *
 * **The failure that causes is not a near miss, it is the suite inverting.** With nothing
 * writing into the profile, `killAndRemove` wins on its first attempt against a directory
 * nobody is defending: the control that must fail passes, the escalation window is never
 * reached so `took` comes in under it, and the profile that "could not be removed" is
 * removed and reported `true`. Those are three of this file's twelve assertions and they
 * go red together — on `main` in CI on 2026-08-25 (twice), and six runs out of six here
 * under a synthetic 3x CPU load. bc-xl7n.136 filed the third of them from the same shape.
 *
 * So the wait is on the evidence rather than on the clock. Two distinct filenames means
 * the interval has fired twice — the child cycles `f0`…`f23` — and a child that has ticked
 * twice is the whole of what any scenario here asks of it. A machine slow enough to miss
 * that in ten seconds is not one whose teardown timings mean anything, and it is a broken
 * fixture rather than a failing assertion, so it stops the run.
 */
function startStub(name, { stubborn = false } = {}) {
  const profile = path.join(sandbox, name);
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(process.execPath, ['-e', CHILD], {
    stdio: 'ignore',
    env: { ...process.env, STUB_PROFILE: profile, STUB_STUBBORN: stubborn ? '1' : '0' },
  });
  live.add(proc);
  const deadline = Date.now() + STUB_READY_TIMEOUT_MS;
  for (;;) {
    let written = 0;
    try {
      written = fs.readdirSync(profile).length;
    } catch {
      /* taken away mid-look, which is itself a child that is running */
    }
    if (written >= 2) return { proc, profile };
    if (proc.exitCode != null || proc.signalCode)
      fatal(`the fake browser '${name}' stays up`, `it exited (${proc.exitCode ?? proc.signalCode}) before writing anything`);
    if (Date.now() > deadline)
      fatal(`the fake browser '${name}' starts writing`, `two ticks never landed in ${STUB_READY_TIMEOUT_MS}ms`);
    settle(10);
  }
}

/* ------------------------------------------ the control: the old two lines, defeated */

// This is the assertion that gives every other one in the file its meaning. It runs the
// exact teardown that shipped before bc-5e85 against the stubborn child, and requires it
// to lose. If this ever passes, the scenario has stopped reproducing the bug and a green
// suite below says nothing at all.
{
  const { proc, profile } = startStub('control-old-teardown', { stubborn: true });
  proc.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the other half of the same failure */
  }
  settle(60);
  if (fs.existsSync(profile)) ok('control: kill-then-delete loses to a process still writing');
  else bad('control: kill-then-delete loses to a process still writing', 'the old shape cleaned up, so this suite cannot fire');
  proc.kill('SIGKILL');
  settle(60);
  removeTreeSync(profile);
}

/* ------------------------------------------------- a browser that goes when asked */

{
  const before = count();
  const { proc, profile } = startStub('polite');
  const started = Date.now();
  // A generous escalation window on purpose. What is being asserted is that a browser
  // which goes on its own does not sit out the window — measured at about 70ms here and
  // 175ms against a real Chrome — and a tight threshold would turn a loaded Mac into a
  // red suite while catching nothing a loose one misses. Code that always escalated
  // would take the full 1500ms and still fail this.
  const removed = killAndRemove(proc, profile, { sigkillAfterMs: 1500, timeoutMs: 5000 });
  const took = Date.now() - started;

  if (removed && !fs.existsSync(profile)) ok('a finished check takes its profile directory with it');
  else bad('a finished check takes its profile directory with it', `removed=${removed}, exists=${fs.existsSync(profile)}`);

  if (count() === before) ok('and the directory it ran in is back to the count it started at');
  else bad('and the directory it ran in is back to the count it started at', `${before} before, ${count()} after`);

  // The escalation window is a ceiling, not a schedule. A teardown that always paid it
  // would add two seconds to every check that runs, which is the kind of fix that gets
  // reverted for being slow rather than for being wrong.
  if (took < 1500) ok('a browser that goes when asked is not waited out');
  else bad('a browser that goes when asked is not waited out', `${took}ms against a 1500ms escalation window`);
}

/* ---------------------------------------------- and one that has to be made to go */

{
  const before = count();
  const { proc, profile } = startStub('stubborn', { stubborn: true });
  const started = Date.now();
  const removed = killAndRemove(proc, profile, { sigkillAfterMs: 400, timeoutMs: 5000 });
  const took = Date.now() - started;

  if (removed && !fs.existsSync(profile)) ok('a browser that ignores SIGTERM is killed and its profile still goes');
  else bad('a browser that ignores SIGTERM is killed and its profile still goes', `removed=${removed}, exists=${fs.existsSync(profile)}`);

  if (count() === before) ok('and that directory is back to its count too');
  else bad('and that directory is back to its count too', `${before} before, ${count()} after`);

  // SIGTERM first is the half that keeps bc-1eru fixed: SIGKILL drops the browser process
  // and leaves the children it was about to collect to be reparented to pid 1. A teardown
  // that reached for it immediately would trade this bug for that one.
  if (took >= 400) ok('SIGTERM is given its window before SIGKILL is reached for');
  else bad('SIGTERM is given its window before SIGKILL is reached for', `gave up asking after ${took}ms`);
}

/* --------------------------------------------------- it answers rather than throwing */

{
  // A profile that cannot be removed is a real outcome and the caller is on its way out,
  // so the contract is a `false`, not an exception thrown from inside somebody's `close()`.
  //
  // **This one is not raced, which is the difference between it and the three above.**
  // They ask what the teardown does while a writer is defending the directory, and a
  // writer is the honest instrument for that. This one asks what it answers when the
  // directory cannot go at all — and a writer is a bad instrument for *that*, because
  // `killAndRemove` only believes a deletion it can still see 40ms later, and 40ms is
  // well inside what a contended machine deschedules a 2ms interval for. The profile then
  // really does go, and the check reads `true`: twice on `main` in CI on 2026-08-25, and
  // once in six runs here even after the readiness handshake above closed the other three.
  //
  // So the impossibility is made structural instead. The profile sits one level down in a
  // holder with no write bit, so the final `rmdir` is `EACCES` no matter how long anything
  // waits or how often it re-asks. The stubborn child stays because `killAndRemove` is
  // still being handed a live process to end — it is the directory that changed, not the
  // browser. A permission bit does not stop root, so the arrangement is probed rather than
  // assumed; without that, a root run would report this as the contract regressing.
  const holder = path.join(sandbox, 'undeletable');
  const probe = path.join(holder, 'probe');
  const { proc, profile } = startStub(path.join('undeletable', 'profile'), { stubborn: true });
  fs.mkdirSync(probe);
  fs.chmodSync(holder, 0o500);
  let enforced = false;
  try {
    fs.rmdirSync(probe);
  } catch {
    enforced = true;
  }
  if (enforced) ok('control: a directory inside a holder with no write bit cannot be removed');
  else bad('control: a directory inside a holder with no write bit cannot be removed', 'it went anyway — running as root?');

  let thrown = null;
  let removed = null;
  try {
    removed = killAndRemove(proc, profile, { sigkillAfterMs: 60_000, timeoutMs: 300 });
  } catch (e) {
    thrown = e;
  }
  if (!thrown && removed === false) ok('a profile it could not remove is reported, not thrown');
  else bad('a profile it could not remove is reported, not thrown', thrown ? String(thrown) : `it returned ${removed}`);
  proc.kill('SIGKILL');
  settle(60);
  fs.chmodSync(holder, 0o700);
  removeTreeSync(holder);
}

/* ----------------------------------------------------------------- the static rule */

// Every check reaches this through `close()`, and the way it regresses is not somebody
// arguing for the old behaviour — it is a copy of the old two lines coming back in an
// edit about something else. There is one delete of a profile in that file and this says so.
const src = fs.readFileSync(HELPER, 'utf8');
const rmCalls = src.match(/fs\.rmSync\(/g) || [];
if (rmCalls.length === 1) ok('the launcher deletes a profile in exactly one place');
else bad('the launcher deletes a profile in exactly one place', `${rmCalls.length} calls to fs.rmSync`);

if (/const teardown = \(\) => \{[^}]*killAndRemove\(/.test(src)) ok("and launchChrome's teardown is that place");
else bad("and launchChrome's teardown is that place", 'the teardown no longer routes through killAndRemove');

// Pinned because the two scenarios above run against overrides to stay fast, so nothing
// else in this file would notice the shipped numbers being changed to something silly.
if (SIGKILL_AFTER_MS === 2_000) ok('the shipped escalation window is two seconds');
else bad('the shipped escalation window is two seconds', String(SIGKILL_AFTER_MS));
if (TEARDOWN_TIMEOUT_MS >= 4_000 && TEARDOWN_TIMEOUT_MS <= 15_000) ok('and the whole teardown budget is seconds, not minutes');
else bad('and the whole teardown budget is seconds, not minutes', String(TEARDOWN_TIMEOUT_MS));

/* -------------------------------------------------------------------- verdict */

cleanup();

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran}\x1b[0m assertions passed\n`);
process.exit(failures ? 1 : 0);
