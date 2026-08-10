#!/usr/bin/env node
/**
 * The process that actually deploys — and the reason it is a separate process.
 *
 * `launchctl kickstart -k gui/<uid>/m4m.beadcause` SIGKILLs beadcause. If the deploy
 * ran inside the daemon, the daemon would be killing itself mid-statement: the HTTP
 * response never written, the next line of the function never reached, and whatever
 * it was about to record about the deploy never recorded. So the daemon spawns this,
 * detached, and returns; this is what the kill lands on, and it is expendable.
 *
 * It writes one file — the record it was handed — and it is the only writer of it
 * from the moment it starts. See lib/deploy.js for why that ownership matters.
 *
 * Three rules it keeps, all versions of *report what happened*:
 *
 * - **Never merge over someone's work.** The pull is `--ff-only`, and a dirty tree
 *   stops the whole deploy before anything is built or restarted. Six sessions edit
 *   these checkouts; a deploy that quietly stashed one of them would be the worst
 *   kind of helpful.
 * - **Record before doing, not after.** The status on disk says which step is in
 *   flight, so a runner that is killed — which is the expected ending of a restart —
 *   leaves behind the step it died at rather than a blank. lib/deploy.js's sweep is
 *   what turns that into a word.
 * - **A non-zero exit is a failure, full stop.** No step's output is scanned for
 *   reassuring strings, and nothing after a failed step runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RECORD = process.argv[2];
if (!RECORD) {
  console.error('usage: deploy-runner.mjs <record.json>');
  process.exit(2);
}

const iso = () => new Date().toISOString();

let rec = JSON.parse(fs.readFileSync(RECORD, 'utf8'));

/**
 * Write the record, atomically, without ever reading it back first.
 *
 * Read-modify-write would be wrong here rather than merely unnecessary: this process
 * is the only writer, so re-reading could only ever pick up a *stale* copy of what is
 * already in memory — or a file some other hand had edited, which is not a reason to
 * lose what actually happened.
 */
function save(patch) {
  rec = { ...rec, ...patch, heartbeatAt: iso() };
  const tmp = `${RECORD}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(rec, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, RECORD);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything a step's output is worth keeping in a JSON record. The log has the rest. */
const TAIL = 4000;

/**
 * Run one argv, capture what it said, and never involve a shell.
 *
 * The output goes to two places on purpose: the tail into the record, where it is
 * what a phone shows when a deploy failed, and the whole of it onto this process's
 * stdout, which the daemon pointed at `<id>.log` before it spawned us.
 */
function run(name, command, { cwd, timeoutMs }) {
  const started = Date.now();
  console.log(`\n=== ${name}: ${command.join(' ')}`);
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command[0], command.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const take = (buf) => {
      const s = buf.toString('utf8');
      process.stdout.write(s);
      out = (out + s).slice(-TAIL);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => {
      clearTimeout(timer);
      // An ENOENT here is the common shape of a typo'd declaration, and it has to
      // read as a failed deploy rather than as a step that did not happen.
      resolve({ name, command, code: 127, ms: Date.now() - started, output: `${out}${err.message}`.slice(-TAIL) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        name,
        command,
        code: timedOut ? 124 : code === null ? 129 : code,
        signal: signal || null,
        ms: Date.now() - started,
        output: timedOut ? `${out}\n[timed out after ${timeoutMs}ms]`.slice(-TAIL) : out,
      });
    });
  });
}

/**
 * Every step that has run, saved or not — `fail` writes the lot, so a deploy that
 * stopped at step four is a record of four steps rather than of the one that broke.
 */
const steps = [];

/** Run a step and keep it. Everything that runs is on the record, pass or fail. */
async function step(name, command, opts) {
  const s = await run(name, command, opts);
  steps.push(s);
  return s;
}

const git = (name, args, opts) => step(name, ['git', '-C', rec.dir, ...args], opts);

function fail(message) {
  save({ status: 'failed', finishedAt: iso(), error: message, steps });
  console.error(`\n*** deploy failed: ${message}`);
  process.exit(1);
}

async function main() {
  // The pid first, before anything else at all. Until it is on disk the sweep has
  // only a startup grace to go on, and the sooner that ends the sooner a runner that
  // died can be told apart from one that is thinking.
  save({ pid: process.pid, startedAt: iso(), status: 'queued' });

  // The beat the daemon needs to finish answering the request that asked for this.
  // See lib/deploy.js — the first thing a beadcause deploy does is kill that process.
  if (rec.plan.graceMs > 0) await sleep(rec.plan.graceMs);

  const opts = { cwd: rec.dir, timeoutMs: rec.plan.timeoutMs };

  if (rec.plan.pull && !fs.existsSync(path.join(rec.dir, '.git'))) {
    // A checkout is not required to deploy — a tarball install has none — but a *pull*
    // is meaningless without one, and silently skipping it would deploy a tree nobody
    // updated while the record claimed otherwise.
    fail(`${rec.dir} is not a git checkout, so there is nothing to bring up to date`);
  }

  if (rec.plan.pull) {
    save({ status: 'pulling' });

    const dirty = await git('git status', ['status', '--porcelain', '--untracked-files=no'], opts);
    if (dirty.code !== 0) fail(`could not read the state of ${rec.dir}`);
    if (dirty.output.trim()) {
      fail(`there is uncommitted work in ${rec.dir} — deploying would mean merging over it, so nothing was run`);
    }

    const before = await git('git rev-parse', ['rev-parse', 'HEAD'], opts);
    if (before.code !== 0) fail(`could not read HEAD in ${rec.dir}`);
    const from = before.output.trim().split('\n').pop();

    const fetched = await git('git fetch', ['fetch', '--quiet', 'origin', rec.base], opts);
    if (fetched.code !== 0) fail(`could not fetch origin/${rec.base}`);

    // Fast-forward only. Anything that would need a real merge is a checkout that has
    // diverged from the branch it deploys, and resolving that is a session's job.
    const merged = await git('git merge --ff-only', ['merge', '--ff-only', `origin/${rec.base}`], opts);
    if (merged.code !== 0) fail(`local ${rec.base} in ${rec.dir} cannot fast-forward to origin/${rec.base}`);

    const after = await git('git rev-parse', ['rev-parse', 'HEAD'], opts);
    const to = after.code === 0 ? after.output.trim().split('\n').pop() : null;

    let changed = [];
    if (from && to && from !== to) {
      const diff = await git('git diff --name-only', ['diff', '--name-only', from, to], opts);
      if (diff.code === 0) changed = diff.output.split('\n').map((t) => t.trim()).filter(Boolean);
    }
    save({ from, to, changed, steps });
  }

  // Rebuild what the pull moved. `when: []` means always — a legitimate thing to
  // declare and a terrible one to arrive at by accident, so `when` is matched against
  // the paths the fast-forward actually touched and nothing else. With `pull: false`
  // there are no such paths, so only an unguarded rebuild runs: this cannot know what
  // moved in a tree it did not move, and guessing "probably everything" would rebuild
  // an APK on every deploy.
  const rebuilds = (rec.plan.rebuild || []).filter(
    (r) => !r.when.length || r.when.some((p) => rec.changed.some((f) => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`)))
  );
  if (rebuilds.length) {
    save({ status: 'building' });
    for (const r of rebuilds) {
      const built = await step(r.label, r.command, opts);
      if (built.code !== 0) fail(`${r.label} failed (exit ${built.code}) — nothing was deployed`);
      save({ steps });
    }
  }

  // Last, and the point of no return for a deploy that restarts beadcause: from here
  // this process may simply stop existing. The status on disk is what says so, and
  // lib/deploy.js's sweep is what turns "stopped at `deploying`" into a word.
  save({ status: 'deploying', steps });
  const deployed = await step('deploy', rec.plan.command, opts);
  if (deployed.code !== 0) fail(`the deploy command failed (exit ${deployed.code})`);

  save({ status: 'ok', finishedAt: iso(), steps, error: null });
  console.log(`\n*** deployed ${rec.workspace}${rec.to ? ` at ${rec.to.slice(0, 8)}` : ''}`);
}

main().catch((err) => {
  try {
    save({ status: 'failed', finishedAt: iso(), error: err?.message || String(err) });
  } catch {
    /* the record is gone; the log is all there is */
  }
  console.error(err);
  process.exit(1);
});
