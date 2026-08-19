#!/usr/bin/env node
/**
 * `npm run checks` — the browser checks, all of them, with a list of what failed.
 *
 *     npm run checks                 # audit, then run every scripts/*-check.mjs
 *     npm run checks -- --audit      # the static half only: no Chrome, milliseconds
 *     npm run checks -- --list       # what would run, without running it
 *     npm run checks -- --only topbar,drawer
 *     npm run checks -- --jobs 6     # how many Chromes at once (default 4)
 *     npm run checks -- --timeout 90 # per check, seconds; 0 to take the leash off
 *     npm run checks -- --no-retry   # the parallel pass raw, without the serial retry
 *     node scripts/checks.mjs --dir <root>   # another tree — this is how it is tested
 *
 * The `scripts/*-check.mjs` are the only cover this repo has for layout, taps and anything
 * that happens on a phone, and until this file existed there was no way to run them but
 * one at a time by name. Which in practice meant: run by
 * whoever remembered that the page they touched had one. `npm test` says nothing about
 * any of them — that suite is pure Node on purpose, because these want a Chrome — so a
 * check could stop passing the moment a selector moved and stay broken for a month.
 * That is worse than no check: the next person to run it reads its failures as their own
 * change breaking something.
 *
 * ## Why it is not just a for-loop
 *
 * They take ten to forty seconds each, so serially this is a coffee break and nobody
 * would run it. Each one binds `127.0.0.1:0` and drives its own Chrome with its own
 * temp profile, so there is nothing shared to collide over — four at a time turns eight
 * minutes into two. Their output interleaves badly, so each child's is captured whole
 * and only failures are replayed, after the summary, in the order they were listed.
 *
 * The parallel pass is a *filter*, not the verdict. Some of these measure time — how
 * long a tab takes to warm, whether a bead is still in the air at 400ms — and four
 * Chromes on one laptop moves those numbers: on the first end-to-end run two of the
 * twenty-six were red at `--jobs 4` and green alone, and a third hung outright and
 * finished in five seconds by itself. So every failure runs again, serially, and the
 * second result is the verdict — with the ones that only passed alone named at the end,
 * because burying that is how a runner acquires a folklore of checks that are "always a
 * bit red". Every check is also on a four-minute leash: a hang is the one failure a
 * runner like this newly introduces, and it is silent in the worst way, because a run
 * that never ends reports nothing about any of the rest either.
 *
 * ## What it does before it runs anything
 *
 * `lib/checkaudit.js` reads every static selector the checks press and asserts each one
 * still exists in `public/`. That is the failure this whole file is about, it costs
 * milliseconds, and it names the check and the line — so it runs first and prints
 * before a single Chrome starts. It does not *stop* the run: a stale selector in one
 * check is no reason not to run the rest. The same audit is in `npm test` as
 * `test/checks.mjs`, which is what makes removing a selector caught by something other
 * than a person remembering.
 *
 * Exit is 0 only if the audit was clean and every check passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, discover } from '../lib/checkaudit.js';
import { onExit, killAndRemoveSync } from '../lib/teardown.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, fallback) => {
  const inline = argv.find((a) => a.startsWith(`${f}=`));
  if (inline) return inline.slice(f.length + 1);
  const at = argv.indexOf(f);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};

/** `--dir <root>` runs against a different tree — which is how the runner itself is tested. */
const ROOT = path.resolve(valueOf('--dir', path.join(HERE, '..')));

const LIST_ONLY = has('--list');
const AUDIT_ONLY = has('--audit');
const NO_AUDIT = has('--no-audit');
const JOBS = Math.max(1, Number(valueOf('--jobs', 4)) || 4);
/**
 * A check that hangs is the one failure this runner could newly introduce, and it is
 * silent in the worst way — the run never ends, so nothing is reported about any of the
 * rest either. These take ten to forty seconds; four minutes is a check that has stopped,
 * not one that is slow. `--timeout 0` turns it off for a debugging session.
 */
const TIMEOUT = Math.max(0, Number(valueOf('--timeout', 240)) || 0) * 1000;
const ONLY = (valueOf('--only', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * `process.exit()` does not wait for stdout, and when stdout is a pipe — which it is
 * every time this is run as `npm run checks | tail`, or from a script — the last writes
 * can be dropped on the floor. The summary is the entire product of this file, so it is
 * flushed before the exit code is handed back.
 */
const leave = async (code) => {
  await new Promise((r) => process.stdout.write('', r));
  process.exit(code);
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

const all = discover(ROOT);
const suites = ONLY.length ? all.filter((f) => ONLY.some((pat) => f.includes(pat))) : all;

if (LIST_ONLY) {
  console.log(suites.join('\n'));
  await leave(0);
}

if (!suites.length) {
  console.log(red(ONLY.length ? `nothing matches --only ${ONLY.join(',')}` : `no ${'*-check.mjs'} found under ${path.join(ROOT, 'scripts')}`));
  await leave(1);
}

/* ----------------------------------------------------------------- the static half */

let auditFailed = false;
if (!NO_AUDIT) {
  const { tokens, findings } = audit(ROOT);
  if (findings.length) {
    auditFailed = true;
    console.log(red(`\nselector audit — ${findings.length} of ${tokens} no longer in public/`));
    for (const f of findings) {
      console.log(`  ${red('✗')} ${f.check}:${f.line}  ${f.token}  ${dim(f.selector)}`);
    }
    console.log(dim('  these checks will fail on the selector, whatever else they are testing\n'));
  } else {
    console.log(green(`selector audit — ${tokens} selectors across ${all.length} checks are still in public/`));
  }
}

if (AUDIT_ONLY) await leave(auditFailed ? 1 : 0);

/* ------------------------------------------------------------------ running them */

/**
 * Full output per child, kept whether it passed or not — a check that passes noisily is
 * still worth reading, and `--keep` on the ones that take it writes paths into it.
 */
const logDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-checks-'));

/**
 * A `$TMPDIR` per check, and the run's own directory removed when it is over — bc-5isv.
 *
 * Two leaks, one shape. The logs above were kept unconditionally, so every green run left
 * a directory nobody would ever read: **2,545 `beadcause-checks-*` directories** were
 * counted on this Mac, the largest single bucket in a `$TMPDIR` that had reached 15 GB.
 * And each check makes its own scratch and removes it in a `finally`, which does not run
 * when the check is *signalled* — which is exactly what happens to any check that
 * overruns `--timeout` below, by this file's own hand.
 *
 * Setting `TMPDIR` for the child fixes the second without touching a single check:
 * `os.tmpdir()` reads it on every call, so everything a check `mkdtemp`s — and everything
 * spawned by it, environment being inherited — lands somewhere this process owns. What a
 * check failed to clean up is cleaned up anyway, and a check that *fails* keeps its
 * scratch, which is strictly more than survived before.
 *
 * `onExit` rather than a plain removal at the bottom, for the third time in this diff and
 * for the same reason each time: a runner that is Ctrl-C'd halfway through is the ordinary
 * way one of these ends. See lib/teardown.js.
 */
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-checkrun-'));
const rmQuietly = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a teardown must never be why a run ends badly — lib/strays.js collects the rest */
  }
};
/**
 * The checks still running, so the exit guard can end them before it removes anything.
 *
 * This is the half that had to be measured rather than assumed. Interrupting a real run
 * and counting what survived, the sandbox was **still there** afterwards — because a
 * signal sent to this process is sent to this process, and the check it had spawned went
 * on running, went on writing into the directory being removed, and went on holding the
 * Chrome it had started. A runner that tidies up without ending its children tidies up
 * nothing. (Ctrl-C in a terminal happens to signal the whole foreground process *group*
 * and so hides this; nothing else does.)
 *
 * Each one gets the same SIGTERM-then-SIGKILL a timeout gives it, which is also what runs
 * the check's *own* exit guard — so its Chrome and its profile go with it.
 */
const live = new Set();
/**
 * What survives the run, and it is two different answers to two different questions.
 *
 * `keepLogs` starts **true**: a run that failed, and a run somebody stopped, both leave
 * the output behind, because on a run somebody stopped the log is the reason they stopped
 * and it is now the only copy of it. Only an all-green summary clears it.
 *
 * `keepScratch` starts **false** and is set only by the failure branch of that same
 * summary — so it can never be set by a run that was interrupted, which is deliberate.
 * The scratch of a check killed mid-flight is not a diagnostic anybody wants and it is
 * where the bytes are; the scratch of a check that *failed on its own* is the config it
 * was working in, and the run prints where it is. Whatever is kept, lib/strays.js
 * collects it a day later.
 */
let keepLogs = true;
let keepScratch = false;
onExit(() => {
  for (const child of live) killAndRemoveSync(child, null, { timeoutMs: 1500, killAfterMs: 700 });
  if (!keepScratch) rmQuietly(sandbox);
  if (!keepLogs) rmQuietly(logDir);
});

const run = (rel) =>
  new Promise((resolve) => {
    const started = Date.now();
    const scratch = fs.mkdtempSync(path.join(sandbox, `${path.basename(rel, '.mjs')}-`));
    const child = spawn(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: scratch },
    });
    live.add(child);
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    /** SIGTERM first so a check with a cleanup handler gets to run it; SIGKILL if it will not go. */
    const timer = TIMEOUT
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, TIMEOUT)
      : null;
    child.on('error', (err) => {
      live.delete(child);
      // Nothing ran, so there is nothing in the scratch to keep.
      rmQuietly(scratch);
      if (timer) clearTimeout(timer);
      resolve({ rel, status: 1, out: `could not start — ${err.message}\n`, ms: Date.now() - started });
    });
    child.on('close', (status, signal) => {
      live.delete(child);
      if (timer) clearTimeout(timer);
      if (timedOut) out += `\ntimed out after ${TIMEOUT / 1000}s — killed\n`;
      const log = path.join(logDir, `${path.basename(rel, '.mjs')}.log`);
      fs.writeFileSync(log, out);
      const ok = !timedOut && !signal && status === 0;
      // The real exit code is kept — `why` prints it, and "exit 2" and "exit 1" are
      // different facts about a check that failed.
      const code = timedOut || signal ? 1 : status;
      // A check that passed has nothing in its scratch anyone wants; one that did not is
      // the only directory worth keeping, and it is now named rather than lost in a
      // `$TMPDIR` twenty sessions share.
      if (ok) rmQuietly(scratch);
      resolve({ rel, status: code, signal, timedOut, out, log, scratch: ok ? null : scratch, ms: Date.now() - started });
    });
  });

console.log(dim(`\n${suites.length} checks, ${JOBS} at a time — logs in ${logDir}\n`));

const why = (r) =>
  r.timedOut
    ? red(` timed out after ${TIMEOUT / 1000}s`)
    : r.signal
      ? red(` killed by ${r.signal}`)
      : r.status === 0
        ? ''
        : red(` exit ${r.status}`);

const results = [];
let next = 0;
let done = 0;

const worker = async () => {
  while (next < suites.length) {
    const rel = suites[next++];
    const r = await run(rel);
    results.push(r);
    done += 1;
    const mark = r.status === 0 ? green('✓') : red('✗');
    console.log(
      `  ${mark} [${String(done).padStart(2)}/${suites.length}] ${path.basename(r.rel).padEnd(26)} ${dim(`${(r.ms / 1000).toFixed(1)}s`)}${why(r)}`,
    );
  }
};

await Promise.all(Array.from({ length: Math.min(JOBS, suites.length) }, worker));

/* ------------------------------------------------------------------- the second run */

/**
 * Every failure runs again, alone, and the second result is the one reported.
 *
 * These checks were written to be run one at a time and some of them measure time —
 * how long a tab takes to warm, whether a bead is still in the air at 400ms. Four
 * Chromes on one laptop is enough to move those numbers, and two of the twenty-six were
 * red at `--jobs 4` and green on their own the first time this was run end to end (a
 * third hung outright and finished in five seconds by itself). A runner that reports
 * those as failures teaches people to disbelieve it, which is precisely the state this
 * whole file was written to get out of.
 *
 * So the parallel pass is a *filter*, not the verdict: cheap, wrong sometimes, and only
 * ever wrong in the direction of running one more check. The retry is serial, with
 * nothing else in flight, which is the condition each of these was written under. What
 * it must not do is hide the flakiness — a check that needed a retry is called out in
 * the summary, because "it only fails when something else is running" is a fact about
 * that check worth knowing, and `--no-retry` reports the parallel pass raw.
 */
const flaky = [];
if (!has('--no-retry')) {
  const shaky = results.filter((r) => r.status !== 0);
  if (shaky.length && suites.length > 1) {
    console.log(dim(`\nre-running ${shaky.length} failed ${shaky.length === 1 ? 'check' : 'checks'} on its own — these were written to run alone\n`));
    for (const first of shaky) {
      const again = await run(first.rel);
      const at = results.indexOf(first);
      results[at] = { ...again, retried: true, firstStatus: first.status, firstTimedOut: first.timedOut };
      if (again.status === 0) flaky.push(first.rel);
      const mark = again.status === 0 ? amber('~') : red('✗');
      console.log(
        `  ${mark} ${path.basename(again.rel).padEnd(26)} ${dim(`${(again.ms / 1000).toFixed(1)}s`)}` +
          (again.status === 0 ? amber(' passed on its own — it does not survive company') : why(again)),
      );
    }
  }
}

/* --------------------------------------------------------------------- the summary */

const order = new Map(suites.map((s, i) => [s, i]));
results.sort((a, b) => order.get(a.rel) - order.get(b.rel));
const failed = results.filter((r) => r.status !== 0);

/**
 * The tail of each failure, replayed. Not the whole log — one check's output is a
 * hundred green ticks and the three lines that matter are at the bottom — and the path
 * to the whole of it, for when it is not.
 */
for (const r of failed) {
  const how = r.timedOut ? `timed out after ${TIMEOUT / 1000}s` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  console.log(red(`\n── ${r.rel} (${how}${r.retried ? ', on its own — not a scheduling accident' : ''})`));
  const lines = r.out.trimEnd().split('\n');
  for (const line of lines.slice(-25)) console.log(`   ${line}`);
  if (lines.length > 25) console.log(dim(`   … ${lines.length - 25} earlier lines in ${r.log}`));
  if (r.scratch) console.log(dim(`   scratch kept in ${r.scratch}`));
}

const wall = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0);
console.log('');
if (failed.length) {
  // The scratch of each failing check is named above and has to still be there when
  // somebody goes to look — see `keepScratch`.
  keepScratch = true;
  console.log(red(`${failed.length} of ${results.length} checks failed:`));
  for (const r of failed) console.log(red(`  • ${r.rel}`));
  console.log(dim(`\nfull output: ${logDir}  (${wall}s of check time)\n`));
} else if (auditFailed) {
  console.log(amber(`all ${results.length} checks passed, but the selector audit above did not\n`));
} else {
  // Nothing failed, so nothing in `logDir` will ever be read — see the header above the
  // sandbox. `keepLogs` is what the exit guard consults; the other two arms leave it set.
  keepLogs = false;
  console.log(green(`all ${results.length} checks passed`) + dim(` (${wall}s of check time)\n`));
}

/**
 * Reported whether or not anything ended up failing: a check that only passes alone is
 * still a fact about that check, and burying it is how a runner ends up with a folklore
 * of "oh, that one is always red".
 */
if (flaky.length) {
  console.log(amber(`${flaky.length} passed only when re-run alone — ${flaky.map((f) => path.basename(f)).join(', ')}`));
  console.log(dim(`  they measure time, and ${JOBS} Chromes at once moves the numbers. --jobs 1 to be sure, --no-retry to see the raw pass\n`));
}

await leave(failed.length || auditFailed ? 1 : 0);
