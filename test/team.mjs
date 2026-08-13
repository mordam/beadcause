#!/usr/bin/env node
/**
 * A second engineer's install: one profile, and the two states it must refuse.
 *
 *     npm test
 *     node test/team.mjs
 *
 * bc-146r. `npm run install-service` was written for somebody setting up their own laptop,
 * and for the second person onward almost every step of it quietly does nothing: the
 * workspace does not exist on their Mac, a plain `git clone` fetches no beads at all
 * (Dolt data rides `refs/dolt/data`), and the one question that decides whether an
 * unattended agent may comment on a graph the whole team reads is answered from scratch,
 * differently, by each of them. `team.json` is where the shared half of those answers
 * stops being a question. See lib/team.js.
 *
 * Everything here is pure, which is the point of the split: lib/team.js turns a profile
 * plus what was *observed* about a workspace into a config patch or a list of steps, and
 * scripts/onboard.mjs owns every side effect. So the six states a tracker can be in are
 * all reachable from a literal, with no `bd` on PATH, no network and no second Mac — and
 * three of those six are states you cannot conveniently produce for real at all.
 *
 * The three claims worth the file:
 *
 * 1. **A committed profile cannot carry a per-machine setting.** `owner`, `me`, the token,
 *    the ntfy topic, `advocates` — those are already per-machine and already right, and a
 *    file that set them would make six Macs claim to be the same person. It is a refusal
 *    rather than an ignored line, because a setting silently dropped from a file the whole
 *    team reviewed is a policy they all believe they have.
 * 2. **The refusals are refusals.** A local database sitting where the team's tracker
 *    goes is never repaired here. `bd bootstrap` will not clone over a database that
 *    exists, so "repairing" it means asking the first `bd dolt pull` to merge two
 *    unrelated histories — the conflict lib/sync.js says nothing has ever retried its way
 *    out of. The plan for those states is empty and carries a sentence naming the fix.
 * 3. **Holding Enter through `npm run configure` no longer un-shares a workspace.** The
 *    default for question 2 was the literal `'none'`, and `ask` turns an empty line into
 *    the default — so a re-run withdrew `autoDispatchExclude` and `ntfy.minimalWorkspaces`
 *    from every workspace, in silence, and the summary printed afterwards read as a fact
 *    about the machine rather than as something the last keystroke had just done.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
};

const {
  readTeam,
  parseTeam,
  configPatch,
  trackerState,
  trackerPlan,
  sameRemote,
  readSyncRemote,
  withSyncRemote,
  teamPath,
  POLICY_KEYS,
  PER_MACHINE,
} = await import(path.join(ROOT, 'lib', 'team.js'));

const REMOTE = 'git+ssh://git@github.com/acme/architecture.git';
const profileOf = (obj) => {
  const { profile, problems } = parseTeam(JSON.stringify(obj));
  assert.deepEqual(problems, [], `expected a clean profile, got: ${problems.join(' | ')}`);
  return profile;
};
const problemsOf = (obj) => parseTeam(JSON.stringify(obj)).problems;
const ONE = { trackers: [{ workspace: 'acme', remote: REMOTE }] };

/* ------------------------------------------------------------- no team is normal */

console.log('a solo install has no team');

check('a missing team.json is not a problem, and not a profile', () => {
  const t = readTeam(path.join(os.tmpdir(), 'beadcause-no-such-team-file.json'));
  assert.equal(t.exists, false);
  assert.equal(t.profile, null);
  assert.deepEqual(t.problems, []);
});

check("this repo's own team.json, if it has one, is valid", () => {
  // A guard for the day somebody writes one: a typo in it would otherwise be found by an
  // engineer's install rather than by the suite that runs before the merge.
  const t = readTeam(teamPath(ROOT));
  if (!t.exists) return;
  assert.deepEqual(t.problems, [], `team.json is committed and broken: ${t.problems.join(' | ')}`);
});

/* --------------------------------------------------- what a profile may not carry */

console.log('\nwhat a committed profile may not carry');

for (const key of Object.keys(PER_MACHINE)) {
  check(`"${key}" at the top level is refused, by name`, () => {
    const problems = problemsOf({ ...ONE, [key]: 'anything' });
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.match(problems[0], new RegExp(`"${key}"`));
    assert.match(problems[0], /per machine/);
  });
}

check('an unknown top-level key is refused, and says what is allowed', () => {
  const problems = problemsOf({ ...ONE, autoShip: true });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /"autoShip"/);
  assert.match(problems[0], /"trackers", "policy" and "note"/);
});

check('a per-machine key inside policy is refused with the same sentence', () => {
  const problems = problemsOf({ ...ONE, policy: { owner: 'Carol' } });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /policy\.owner/);
  assert.match(problems[0], /per machine/);
});

check('autoDispatch is refused as policy — the boundary worth pinning', () => {
  // It looks like the obvious team setting and it is not: the shared workspace is
  // excluded from auto-dispatch by being shared, so the global flag governs the
  // engineer's own private workspaces, which is nobody else's business.
  const problems = problemsOf({ ...ONE, policy: { autoDispatch: false } });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /policy\.autoDispatch is not team policy/);
  assert.match(problems[0], new RegExp(Object.keys(POLICY_KEYS).join('|')));
});

check('a profile naming no trackers is refused rather than accepted as empty', () => {
  const problems = problemsOf({ policy: { sync: { seconds: 60 } } });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /names no trackers/);
});

check('a tracker with no remote is refused', () => {
  const problems = problemsOf({ trackers: [{ workspace: 'acme' }] });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /no "remote"/);
});

check('an scp-style git address is refused — it looks right and is not a URL', () => {
  const problems = problemsOf({ trackers: [{ workspace: 'acme', remote: 'git@github.com:acme/architecture.git' }] });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /is not a URL/);
});

check('an unknown tracker field is refused', () => {
  const problems = problemsOf({ trackers: [{ workspace: 'acme', remote: REMOTE, prefix: 'ac' }] });
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /"prefix" is not a tracker field/);
});

check('two trackers on one workspace are refused', () => {
  const problems = problemsOf({
    trackers: [
      { workspace: 'acme', remote: REMOTE },
      { workspace: 'acme', remote: 'git+ssh://git@github.com/acme/other.git' },
    ],
  });
  assert.ok(
    problems.some((p) => /named by two trackers/.test(p)),
    problems.join(' | ')
  );
});

check('sync.seconds is accepted, and a nonsense one is refused', () => {
  assert.equal(profileOf({ ...ONE, policy: { sync: { seconds: 300 } } }).policy['sync.seconds'], 300);
  assert.match(problemsOf({ ...ONE, policy: { sync: { seconds: -1 } } })[0], /positive number of seconds/);
});

check('a profile that is not JSON, or not an object, says so', () => {
  assert.match(parseTeam('{ nope').problems[0], /not valid JSON/);
  assert.match(parseTeam('[]').problems[0], /must be a JSON object/);
});

/* ------------------------------------------------------------------ the defaults */

console.log('\nwhat a tracker means by default');

check('a tracker is shared unless it says otherwise, and lands under ~/beads', () => {
  const [t] = profileOf(ONE).trackers;
  assert.equal(t.shared, true);
  assert.equal(t.dir, path.join(os.homedir(), 'beads', 'acme'));
});

check('dir is honoured, ~ and all — a workspace need not live under ~/beads', () => {
  // Climative's lives inside the `architecture` checkout, because that is the repo the
  // team already clones, so nothing here may build a path out of the workspace's name.
  const [t] = profileOf({ trackers: [{ workspace: 'acme', remote: REMOTE, dir: '~/work/architecture' }] }).trackers;
  assert.equal(t.dir, path.join(os.homedir(), 'work', 'architecture'));
});

/* ------------------------------------------------------------------- the patch */

console.log('\nthe policy it writes, and the policy it leaves alone');

check('a shared tracker gets all three protections', () => {
  const { patch, changes } = configPatch(profileOf(ONE), {});
  assert.deepEqual(patch.autoDispatchExclude, ['acme']);
  assert.deepEqual(patch.ntfy.minimalWorkspaces, ['acme']);
  assert.equal(patch.autoEndorsePerWorkspace.acme, false);
  assert.equal(changes.length, 3, changes.join(' | '));
});

check('applying it twice changes nothing the second time', () => {
  const profile = profileOf({ ...ONE, policy: { sync: { seconds: 300 } } });
  const cfg = { ntfy: { enabled: true }, sync: { enabled: true, seconds: 120 } };
  const first = configPatch(profile, cfg);
  assert.ok(first.changes.length);
  const second = configPatch(profile, { ...cfg, ...first.patch });
  assert.deepEqual(second.changes, [], second.changes.join(' | '));
});

check('it never removes a name the engineer put there themselves', () => {
  const { patch } = configPatch(profileOf(ONE), {
    autoDispatchExclude: ['private'],
    ntfy: { minimalWorkspaces: ['private'] },
  });
  assert.deepEqual(patch.autoDispatchExclude.sort(), ['acme', 'private']);
  assert.deepEqual(patch.ntfy.minimalWorkspaces.sort(), ['acme', 'private']);
});

check('shared: false asks for nothing', () => {
  const { patch, changes } = configPatch(profileOf({ trackers: [{ workspace: 'acme', remote: REMOTE, shared: false }] }), {});
  assert.deepEqual(patch, {});
  assert.deepEqual(changes, []);
});

check('a policy key is merged into its block, not over it', () => {
  const { patch } = configPatch(profileOf({ ...ONE, policy: { sync: { seconds: 300 } } }), {
    sync: { enabled: false, seconds: 120 },
  });
  assert.equal(patch.sync.seconds, 300);
  assert.equal(patch.sync.enabled, false, 'sync.enabled was flattened by a patch to sync.seconds');
});

check('nothing per-machine can reach the patch, whatever the profile says', () => {
  // The belt to the validator's braces: even a profile that somehow got past `parseTeam`
  // must not be able to write one of these. Asserted over the whole patch rather than key
  // by key, so a new per-machine setting is covered the day it is named.
  const { patch } = configPatch(
    { trackers: profileOf(ONE).trackers, policy: { owner: 'Carol', me: 'carol@example.com', 'ntfy.topic': 'x' } },
    {}
  );
  for (const key of Object.keys(PER_MACHINE)) {
    if (key === 'ntfy') {
      // `ntfy` is touched, but only its `minimalWorkspaces` — never the topic.
      assert.deepEqual(Object.keys(patch.ntfy || {}).filter((k) => k !== 'minimalWorkspaces'), []);
      continue;
    }
    assert.equal(patch[key], undefined, `the patch reached ${key}`);
  }
});

/* -------------------------------------------------------------- the six states */

console.log('\nthe six states a tracker can be in on this Mac');

const T = profileOf(ONE).trackers[0];
const states = {
  absent: {},
  declared: { beadsExists: true, configRemote: REMOTE },
  ready: { beadsExists: true, hasDb: true, remote: { name: 'origin', url: REMOTE }, issues: 412 },
  empty: { beadsExists: true, hasDb: true, remote: { name: 'origin', url: REMOTE }, issues: 0 },
  unwired: { beadsExists: true, hasDb: true, remote: null, issues: 7 },
  elsewhere: { beadsExists: true, hasDb: true, remote: { name: 'origin', url: 'git+ssh://git@github.com/acme/nope.git' } },
};

for (const [want, observed] of Object.entries(states)) {
  check(`${want} is read as ${want}`, () => assert.equal(trackerState(T, observed), want));
}

check('a directory with a config.yaml but no database is declared, not absent', () => {
  // The state a failed bootstrap leaves behind, and the reason it matters is that
  // bootstrapping again is the fix — so it must not read as "nothing to do".
  assert.equal(trackerState(T, states.declared), 'declared');
  assert.deepEqual(
    trackerPlan(T, states.declared).steps.map((s) => s.kind),
    ['bd']
  );
});

check('absent plans exactly three steps, in the one order that works', () => {
  const { steps } = trackerPlan(T, states.absent);
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['mkdir', 'write', 'bd']
  );
  assert.equal(steps[1].remote, REMOTE);
  assert.deepEqual(steps[2].argv, ['bootstrap', '--yes']);
  // The remote has to be written down *before* bootstrap, because that is what bootstrap
  // reads to decide it is cloning rather than creating: measured, `bd bootstrap --dry-run
  // --json` on a `.beads` holding nothing but a config.yaml with sync.remote answers
  // `{"action":"sync","reason":"sync.remote configured — will clone from …"}`.
  assert.ok(steps.findIndex((s) => s.kind === 'write') < steps.findIndex((s) => s.kind === 'bd'));
});

check('no plan can remove or move anything', () => {
  for (const observed of Object.values(states)) {
    for (const step of trackerPlan(T, observed).steps) {
      assert.ok(['mkdir', 'write', 'bd'].includes(step.kind), `step kind ${step.kind}`);
      const argv = (step.argv || []).join(' ');
      assert.doesNotMatch(argv, /\b(rm|mv|delete|--force|--hard)\b/, `destructive argv: ${argv}`);
    }
  }
});

check('ready and empty plan nothing at all', () => {
  for (const state of ['ready', 'empty']) {
    const plan = trackerPlan(T, states[state]);
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.refusal, null);
  }
});

check('a private tracker in the way is refused, and the refusal names the fix', () => {
  const plan = trackerPlan(T, states.unwired);
  assert.deepEqual(plan.steps, []);
  assert.match(plan.refusal, /unrelated histories/);
  assert.match(plan.refusal, /\.local/, 'the refusal must say how to move it aside');
  assert.match(plan.refusal, /7/, 'it should say how many beads are at stake');
});

check('a tracker wired elsewhere is refused, and both remotes are named', () => {
  const plan = trackerPlan(T, states.elsewhere);
  assert.deepEqual(plan.steps, []);
  assert.match(plan.refusal, /acme\/nope/);
  assert.match(plan.refusal, /acme\/architecture/);
});

check('two spellings of one remote are the same remote', () => {
  assert.ok(sameRemote(REMOTE, 'git+ssh://git@GITHUB.com/acme/architecture'));
  assert.ok(sameRemote(REMOTE, `${REMOTE}/`));
  assert.ok(!sameRemote(REMOTE, 'git+ssh://git@github.com/acme/Architecture.git'), 'the path is case-sensitive');
  assert.ok(!sameRemote(null, REMOTE));
});

/* ---------------------------------------------------------- the config.yaml write */

console.log("\nnaming the remote in bd's own config file");

const STOCK = `# Beads Configuration File
# All settings can also be set via environment variables

# Issue prefix for this repository (used by bd init)
# issue-prefix: ""
`;

check('the remote is added and every comment survives', () => {
  const out = withSyncRemote(STOCK, REMOTE);
  assert.ok(out.startsWith('# Beads Configuration File'));
  assert.match(out, /# issue-prefix/);
  assert.equal(readSyncRemote(out), REMOTE);
});

check('a file that already names it is returned untouched', () => {
  const once = withSyncRemote(STOCK, REMOTE);
  assert.equal(withSyncRemote(once, REMOTE), once);
});

check('a file naming a different remote is refused, not rewritten', () => {
  const other = withSyncRemote(STOCK, 'git+ssh://git@github.com/acme/other.git');
  assert.equal(withSyncRemote(other, REMOTE), null);
});

check('an unreadable config.yaml reads as no remote rather than throwing', () => {
  assert.equal(readSyncRemote('sync:\n  remote: [oh, dear\n'), null);
  assert.equal(readSyncRemote(''), null);
});

/* ------------------------------------------------------------------- the wiring */

console.log('\nthe wiring a refactor would break in silence');

check('install.sh runs the onboarding, before the questions', () => {
  const sh = read('scripts/install.sh');
  const onboard = sh.indexOf('scripts/onboard.mjs');
  const configure = sh.indexOf('node scripts/configure.js');
  assert.ok(onboard > 0, 'install.sh never runs scripts/onboard.mjs');
  assert.ok(onboard < configure, 'the tracker must exist before the questions are asked about it');
});

check('and it stops the install on exit 1, which is the refusal', () => {
  const sh = read('scripts/install.sh');
  assert.match(sh, /ONBOARD_RC/, 'the exit code is thrown away');
  assert.match(sh, /\[ "\$ONBOARD_RC" = 1 \]/);
  // Before anything is booted out — the same argument as the bootstrap probe.
  assert.ok(sh.indexOf('ONBOARD_RC') < sh.indexOf('launchctl bootout'));
});

check('npm run onboard exists', () => {
  assert.equal(JSON.parse(read('package.json')).scripts.onboard, 'node scripts/onboard.mjs');
});

check("configure.js no longer defaults question 2 to 'none'", () => {
  const js = read('scripts/configure.js');
  assert.doesNotMatch(js, /ask\('   shared:', 'none'\)/, "holding Enter would un-share every workspace");
  assert.match(js, /ask\('   shared:', sharedDefault\)/);
  assert.match(js, /teamShared/, 'the team profile is not consulted for the default');
});

check('onboard.mjs owns the side effects, and lib/team.js none of them', () => {
  // The split this suite depends on: if lib/team.js grows a spawn or a write, the plan
  // stops being the whole story and everything asserted above is asserting half of it.
  const lib = read('lib/team.js');
  assert.doesNotMatch(lib, /spawnSync|execFile|writeFileSync|mkdirSync|rmSync/);
  assert.match(read('scripts/onboard.mjs'), /spawnSync/);
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} good\x1b[0m`}`);
process.exit(failures ? 1 : 0);
