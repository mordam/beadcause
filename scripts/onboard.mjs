#!/usr/bin/env node
/**
 * Point this Mac at the team's tracker — the step the second engineer's install was missing.
 *
 *     npm run onboard                 # do it
 *     npm run onboard -- --dry-run    # print the plan and change nothing
 *
 * Run for you by `npm run install-service`, before the questions, so that everything
 * downstream — `discoverWorkspaces()`, the shared-workspace question, the daemon's first
 * poll — is looking at a tracker that exists and has the team's beads in it. Re-runnable:
 * on a machine that is already set up it reads three cheap `bd` calls per tracker and
 * says what it found.
 *
 * **With no `team.json` it prints one line and exits 0.** A solo install has no team, and
 * this must not become a step that people learn to ignore. See lib/team.js for the file's
 * shape, for the argument about what a committed profile may and may not carry, and for
 * why two of the six states it can find are refusals rather than repairs.
 *
 * Three exit codes, and the installer reads them differently, which is the whole reason
 * there are three:
 *
 *   0  nothing to do, or it was done.
 *   1  **refused** — something needs a person, and installing over it would wire a
 *      machine that conflicts on every sync tick. install.sh stops here, while the
 *      service that is already loaded is still running, for the same reason its
 *      bootstrap probe comes before the bootout.
 *   2  a step failed — no network, ssh not unlocked, `bd` unhappy. Transient by nature,
 *      so the installer warns and carries on, and the daemon's own sync banner is what
 *      keeps saying so until it works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfig, saveConfig, CONFIG_PATH } from '../lib/config.js';
import {
  readTeam,
  configPatch,
  trackerPlan,
  describeState,
  readSyncRemote,
  withSyncRemote,
  PER_MACHINE,
} from '../lib/team.js';
import { tildeHome } from '../lib/reposcan.js';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const say = (s) => console.log(`${bold('==>')} ${s}`);
const warn = (s) => console.error(`\x1b[33m warn\x1b[0m ${s}`);
const no = (s) => console.error(`\x1b[31mrefused\x1b[0m ${s}`);

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`Point this Mac at the team's tracker, as named in team.json.

  npm run onboard                 create and bootstrap what is missing
  npm run onboard -- --dry-run    print the plan and change nothing

Exit 1 means something needs a person and nothing was changed; exit 2 means a step
failed and may work next time. With no team.json this does nothing at all.`);
  process.exit(0);
}
const dryRun = argv.includes('--dry-run') || argv.includes('-n');
for (const arg of argv) {
  if (!['--dry-run', '-n', '--yes', '-y'].includes(arg)) {
    warn(`ignoring unknown option ${arg}`);
  }
}

/**
 * `bd`, never through a shell.
 *
 * Not a stylistic preference: `~/.zshenv` on this machine rewrites `BEADS_DIR` from the
 * shell's working directory, so a `bd` reached through `sh -c` can be pointed at an
 * entirely different tracker than the one being set up here — and the calls below include
 * one that clones a database. `BEADS_DIR` in the child's environment plus `cwd` is what
 * makes the target unambiguous.
 */
function bd(args, { cwd, beadsDir, timeout = 300_000 } = {}) {
  const r = spawnSync('bd', args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    env: { ...process.env, ...(beadsDir ? { BEADS_DIR: beadsDir } : {}) },
    encoding: 'utf8',
    timeout,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    failed: r.status !== 0,
    error: r.error ? r.error.message : (r.stderr || '').trim().split('\n')[0] || `bd ${args[0]} exited ${r.status}`,
  };
}

const asJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * What is actually on this Mac for one tracker.
 *
 * **`bd dolt remote list` is what decides whether there is a database**, by whether it
 * works at all: it exits 1 with "no beads database found" on a workspace that is only a
 * directory, and 0 with the rows on one that has been bootstrapped. Two calls answer
 * everything, and the one that would look like the obvious probe is measured to be wrong —
 *
 * `bd bootstrap --dry-run --json` reports **`has_existing: false` on a workspace whose
 * database exists**, whenever `sync.remote` is configured. Its branches are tried in
 * order and the remote comes first, so the field describes the clone it has chosen rather
 * than what is on disk. That is precisely the state this script creates, so the first
 * version of it re-planned a bootstrap on every re-run and got `can't create database
 * beads; database exists` — a warning, on an install that was perfectly finished.
 *
 * A probe that fails for any *other* reason is reported rather than read as "nothing
 * there": planning a clone over a database we simply could not see is the one mistake in
 * here that costs somebody an afternoon.
 */
function observe(tracker) {
  const beadsDir = path.join(tracker.dir, '.beads');
  const configFile = path.join(beadsDir, 'config.yaml');
  const beadsExists = fs.existsSync(beadsDir);
  const configRemote = fs.existsSync(configFile) ? readSyncRemote(fs.readFileSync(configFile, 'utf8')) : null;
  const bare = { beadsExists, configRemote, hasDb: false, remote: null, issues: null };
  if (!beadsExists) return bare;

  const probe = bd(['dolt', 'remote', 'list', '--json'], { cwd: tracker.dir, beadsDir, timeout: 60_000 });
  if (probe.failed) {
    if (/no beads database found|no active beads workspace/i.test(`${probe.stdout}${probe.stderr}`)) return bare;
    return { ...bare, probeError: probe.error };
  }
  const rows = asJson(probe.stdout);
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const remote = first
    ? typeof first === 'string'
      ? { name: first, url: null }
      : { name: first.name || first.remote || 'origin', url: first.url || first.sql_url || null }
    : null;
  const stats = asJson(bd(['stats', '--json'], { cwd: tracker.dir, beadsDir, timeout: 60_000 }).stdout);
  const total = stats?.summary?.total_issues;
  return { beadsExists, configRemote, hasDb: true, remote, issues: typeof total === 'number' ? total : null };
}

/** One step, for real. Returns null when it worked, or the sentence that says it did not. */
function apply(step) {
  switch (step.kind) {
    case 'mkdir':
      // 0700 at creation rather than after: bd warns about a `.beads` at 0755 and
      // recommends exactly this, and a chmod afterwards leaves a window where it is not.
      fs.mkdirSync(step.path, { recursive: true, mode: step.mode ?? 0o700 });
      return null;
    case 'write': {
      const before = fs.existsSync(step.path) ? fs.readFileSync(step.path, 'utf8') : '';
      const after = withSyncRemote(before, step.remote);
      if (after === null) return `${tildeHome(step.path)} already names a different sync.remote — left alone.`;
      if (after !== before) fs.writeFileSync(step.path, after);
      return null;
    }
    case 'bd': {
      const r = bd(step.argv, { cwd: step.cwd, beadsDir: step.beadsDir });
      return r.failed ? `bd ${step.argv.join(' ')} failed — ${r.error}` : null;
    }
    default:
      return `unknown step ${step.kind}`;
  }
}

/* ------------------------------------------------------------------ the profile */

const team = readTeam();

if (!team.exists) {
  say(`no ${bold('team.json')} in this checkout — nothing to point at a shared tracker.`);
  console.log(
    dim(
      `  A solo install needs none: workspaces under ~/beads are discovered on their own.\n` +
        `  See "Onboarding a second engineer" in the README for the file, if this is a team.`
    )
  );
  process.exit(0);
}

if (team.problems.length) {
  no(`${tildeHome(team.path)} cannot be used, so nothing was changed:`);
  for (const p of team.problems) console.error(`        • ${p}`);
  process.exit(1);
}

const { trackers, policy, note } = team.profile;
say(`${bold(`the team's tracker${trackers.length === 1 ? '' : 's'}`)} ${dim(`(${tildeHome(team.path)})`)}`);
if (note) console.log(dim(`  ${note}`));

/* ------------------------------------------------------------------ the trackers */

let refused = 0;
let failed = 0;
let acted = 0;

for (const tracker of trackers) {
  const observed = observe(tracker);
  if (observed.probeError) {
    // Not read as "there is nothing there": that reading plans a clone over a database
    // somebody's beads are in, and `bd` was only unable to answer.
    failed += 1;
    warn(`${tracker.workspace}: could not read the workspace, so nothing was planned for it — ${observed.probeError}`);
    continue;
  }
  const plan = trackerPlan(tracker, observed);
  console.log(`\n  ${describeState(plan.state, tracker)}`);

  if (plan.refusal) {
    refused += 1;
    no(plan.refusal);
    continue;
  }
  if (!plan.steps.length) continue;

  for (const step of plan.steps) console.log(dim(`    ${dryRun ? 'would' : '·'} ${step.what}`));
  if (dryRun) continue;

  let broke = false;
  for (const step of plan.steps) {
    const problem = apply(step);
    if (problem) {
      failed += 1;
      broke = true;
      warn(problem);
      break;
    }
  }
  if (broke) {
    warn(
      `${tracker.workspace} is not synced yet. The daemon will keep saying so — a workspace with a remote it cannot ` +
        `reach is exactly the banner lib/sync.js exists to raise — and \`npm run onboard\` picks up where this stopped.`
    );
    continue;
  }
  acted += 1;

  // Said now, at the moment the count is known, rather than discovered as an empty inbox
  // this evening: a tracker that bootstrapped to nothing is a real state and it is not
  // this install's failure, but it is never what somebody expected to see.
  const after = observe(tracker);
  if (after.issues === 0) {
    console.log(
      dim(
        `    bootstrapped, and the tracker has no beads in it. That is what is on the remote — nobody has pushed any ` +
          `yet, or they pushed to somewhere else. It is not an install that half-worked.`
      )
    );
  } else if (typeof after.issues === 'number') {
    console.log(dim(`    ${after.issues} bead(s) are now on this Mac.`));
  }
}

/* -------------------------------------------------------------------- the policy */

const cfg = loadConfig();
const { patch, changes } = configPatch(team.profile, cfg);

console.log(`\n  ${bold('policy')} ${dim(tildeHome(CONFIG_PATH))}`);
if (!changes.length) {
  console.log(dim('    already what the team profile asks for.'));
} else {
  for (const c of changes) console.log(dim(`    ${dryRun ? 'would set' : 'set'} ${c}`));
  if (!dryRun) saveConfig({ ...cfg, ...patch });
}
if (Object.keys(policy).length && dryRun) console.log(dim('    (dry run — nothing written)'));

// The other half of the promise, said out loud, because the file's restraint is invisible
// otherwise: an engineer reading this needs to know the profile did *not* quietly make
// their Mac claim to be somebody else's. Named from lib/team.js's own list, so a setting
// that stops being refused stops being claimed here in the same breath.
console.log(dim(`    left per machine: ${Object.keys(PER_MACHINE).join(', ')} — a team profile may not set any.`));

/* --------------------------------------------------------------------- the ending */

console.log('');
if (refused) {
  // Said precisely, because the policy above *was* written: it is additive and protective —
  // marking a shared workspace shared is the safe direction whatever else is wrong — while
  // nothing was created, cloned or moved for a tracker that needs a decision.
  no(`${refused} tracker(s) need a decision — nothing was created, cloned or moved for them.`);
  process.exit(1);
}
if (failed) {
  warn(`${failed} tracker(s) did not finish. Re-run ${bold('npm run onboard')} once the reason is fixed.`);
  process.exit(2);
}
say(
  dryRun
    ? 'dry run — no tracker was touched and no policy written.'
    : acted
      ? 'the team tracker is on this Mac.'
      : 'nothing to do.'
);
process.exit(0);
