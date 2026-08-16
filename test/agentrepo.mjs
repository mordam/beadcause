#!/usr/bin/env node
//
// Tier 3: the repo one agent owns, the fence around it, and the experiment.
//
//   npm test                       (runs it alongside the other suites)
//   node test/agentrepo.mjs        (on its own)
//
// Four things are worth a test here and the rest is plumbing:
//
// 1. **The fence has to hold**, because this is the one grant of write access an
//    unattended agent has. `..`, an absolute path, a symlink planted in the tree, a
//    `.git/config` written by hand, `git -C somewhere-else`, `git push` — every one of
//    those is a way the sentence "it may write inside its own directory and nowhere
//    else" stops being true, and every one of them is cheap to test and expensive to
//    discover.
// 2. **`agents/` must be ignored by the common repo**, on installs that predate the
//    rule as well as fresh ones. `~/.config/beadcause` runs `git add -A`, so the failure
//    mode is an agent's private files landing in a shared history — silently, and
//    exactly once.
// 3. **The measurement has to be right**, because the whole bead is a comparison and a
//    miscounted `readFirst` is a wrong answer that looks like a finding. A run where the
//    agent did nothing has to count as a run.
// 4. **Nothing is seeded.** An empty repo is the instrument. A test is the only thing
//    that stops a README appearing in there the first time somebody finds it confusing.
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR. Nothing here touches the real
// ~/.config/beadcause, and nothing pushes anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WRAPPER = path.join(ROOT, 'bin', 'beadcause-agentrepo');

/* --------------------------------------------------------------- harness */

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const rejects = async (name, fn, match) => {
  try {
    await fn();
    bad(name, 'expected it to throw, and it did not');
  } catch (err) {
    check(name, !match || match.test(err.message), `message was: ${err.message}`);
  }
};

const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tier3-'));
process.env.BEADCAUSE_CONFIG_DIR = CONFIG;

const agentrepo = await import('../lib/agentrepo.js');
const { AGENTS_DIR, USAGE_LOG } = agentrepo;

/** Run the wrapper the way an agent would: env-pinned, no arguments of ours. */
function wrap(args, { dir, run = 'r1', arm = 'blind', input = '' } = {}) {
  const r = spawnSync(process.execPath, [WRAPPER, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      BEADCAUSE_CONFIG_DIR: CONFIG,
      BEADCAUSE_AGENT_REPO: dir,
      BEADCAUSE_AGENT_REPO_RUN: run,
      BEADCAUSE_AGENT_REPO_ARM: arm,
    },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/* ---------------------------------------------------------------- names */

console.log('\nnames and containment');

await rejects('a workspace with a slash is refused, not sanitised', async () => agentrepo.repoDir('a/b', 'advocate'), /bad workspace/);
await rejects('.. in an agent name is refused', async () => agentrepo.repoDir('ws', '..'), /bad agent/);
check(
  'repoDir is <config>/agents/<workspace>/<agent>',
  agentrepo.repoDir('beadcause', 'advocate') === path.join(AGENTS_DIR, 'beadcause', 'advocate')
);
check('isRepoDir accepts exactly two levels', agentrepo.isRepoDir(path.join(AGENTS_DIR, 'ws', 'advocate')));
check('isRepoDir refuses one level', !agentrepo.isRepoDir(path.join(AGENTS_DIR, 'ws')));
check('isRepoDir refuses three', !agentrepo.isRepoDir(path.join(AGENTS_DIR, 'ws', 'advocate', 'deeper')));
check('isRepoDir refuses somewhere else entirely', !agentrepo.isRepoDir('/tmp'));
check('isRepoDir refuses a walk back out', !agentrepo.isRepoDir(path.join(AGENTS_DIR, 'ws', '..', '..', 'consoles')));

/* --------------------------------------------------------- provisioning */

console.log('\nprovisioning');

const { dir, created } = await agentrepo.ensureAgentRepo('beadcause', 'advocate');
check('it creates the repo', created && fs.existsSync(path.join(dir, '.git')));

const seeded = fs.readdirSync(dir).filter((f) => f !== '.git');
check('it seeds nothing at all — the empty repo IS the experiment', seeded.length === 0, `found: ${seeded.join(', ')}`);

check('the directory is owner-only', (fs.statSync(dir).mode & 0o077) === 0);
check('so is the workspace above it', (fs.statSync(path.dirname(dir)).mode & 0o077) === 0);

const remotes = execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf8' }).trim();
check('no remote is configured', remotes === '', `remotes: ${remotes}`);

const author = execFileSync('git', ['config', 'user.name'], { cwd: dir, encoding: 'utf8' }).trim();
check('commits will be authored by the agent, not by whoever owns the Mac', author === 'advocate');

const again = await agentrepo.ensureAgentRepo('beadcause', 'advocate');
check('provisioning twice is a no-op', !again.created && again.dir === dir);

// A file git left group-readable, and one git deliberately made read-only.
fs.writeFileSync(path.join(dir, 'loose'), 'x', { mode: 0o644 });
fs.chmodSync(path.join(dir, 'loose'), 0o644);
const ro = path.join(dir, 'readonly');
fs.writeFileSync(ro, 'x');
fs.chmodSync(ro, 0o444);
agentrepo.harden(dir);
check('harden narrows a group-readable file', (fs.statSync(path.join(dir, 'loose')).mode & 0o077) === 0);
check(
  'harden keeps git\'s read-only objects read-only while narrowing them',
  (fs.statSync(ro).mode & 0o777) === 0o400,
  `mode is ${(fs.statSync(ro).mode & 0o777).toString(8)}`
);
fs.rmSync(path.join(dir, 'loose'));
fs.chmodSync(ro, 0o600);
fs.rmSync(ro);

/* -------------------------------------------------------------- the fence */

console.log('\nthe fence');

let r = wrap(['write', 'notes.md'], { dir, input: 'first thing I wrote\n' });
check('write lands', r.code === 0 && fs.readFileSync(path.join(dir, 'notes.md'), 'utf8') === 'first thing I wrote\n');
check('and it is written owner-only', (fs.statSync(path.join(dir, 'notes.md')).mode & 0o077) === 0);

r = wrap(['cat', 'notes.md'], { dir });
check('cat reads it back', r.code === 0 && r.out === 'first thing I wrote\n');

r = wrap(['write', 'notes.md', '--append'], { dir, input: 'and another\n' });
check('--append appends rather than truncating', r.code === 0);
check('…both lines are there', fs.readFileSync(path.join(dir, 'notes.md'), 'utf8') === 'first thing I wrote\nand another\n');

r = wrap(['ls'], { dir });
check('ls lists it', r.code === 0 && /notes\.md/.test(r.out));

r = wrap(['cat', 'nothing-here'], { dir });
check('a missing file exits non-zero rather than printing nothing', r.code === 1);

r = wrap(['write', '../escape.md'], { dir, input: 'no' });
check('.. is refused', r.code === 1 && /outside your repo/.test(r.err));
check('…and nothing was written', !fs.existsSync(path.join(path.dirname(dir), 'escape.md')));

r = wrap(['write', '/tmp/escape.md'], { dir, input: 'no' });
check('an absolute path is refused', r.code === 1 && /relative to the repo/.test(r.err));

fs.symlinkSync(os.tmpdir(), path.join(dir, 'out'));
r = wrap(['write', 'out/escape.md'], { dir, input: 'no' });
check('a symlink planted in the tree cannot be walked out of', r.code === 1 && /outside your repo/.test(r.err));
check('…and nothing was written through it', !fs.existsSync(path.join(os.tmpdir(), 'escape.md')));
fs.rmSync(path.join(dir, 'out'));

r = wrap(['write', '.git/config'], { dir, input: '[remote "origin"]\n' });
check('.git is out of bounds for the file verbs — that is how a remote gets added', r.code === 1 && /use `beadcause-agentrepo git`/.test(r.err));

r = wrap(['ls'], { dir: path.join(CONFIG, 'consoles') });
check('a repo path outside agents/ is refused', r.code === 1 && /not an agent repo/.test(r.err));

r = wrap(['ls'], { dir: '' });
check('and an unset one says who sets it', r.code === 1 && /only beadcause sets it/.test(r.err));

/* ----------------------------------------------------------------- git */

console.log('\ngit, pinned');

r = wrap(['git', 'status', '--short'], { dir });
check('git status works', r.code === 0 && /notes\.md/.test(r.out));

r = wrap(['git', 'add', 'notes.md'], { dir });
check('git add works', r.code === 0);
r = wrap(['git', 'commit', '-m', 'what I noticed'], { dir });
check('git commit works without an editor and without a global identity', r.code === 0, r.err);

r = wrap(['git', 'log', '--oneline'], { dir });
check('git log keeps its own flags — they are not eaten as ours', r.code === 0 && /what I noticed/.test(r.out));

const who = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: dir, encoding: 'utf8' }).trim();
check('the commit is the agent\'s', who === 'advocate', `author was ${who}`);

for (const sub of ['push', 'fetch', 'pull', 'clone', 'remote']) {
  r = wrap(['git', sub], { dir });
  check(`git ${sub} is refused — tier 3 is local-only`, r.code === 1 && /local-only/.test(r.err));
}

r = wrap(['git', '-C', os.tmpdir(), 'status'], { dir });
check('an option before the subcommand is refused — `git -C a -C b` chains', r.code === 1 && /no options before/.test(r.err));

r = wrap(['git', 'log', '--git-dir=/tmp/x'], { dir });
check('--git-dir is refused wherever it appears', r.code === 1 && /somewhere else/.test(r.err));

r = wrap(['git', 'config', '--global', 'user.name', 'someone'], { dir });
check('git config cannot reach the global config', r.code === 1 && /this repo's config only/.test(r.err));

/* ------------------------------------------------------ the measurement */

console.log('\nthe measurement');

check('git log counts as a read', agentrepo.kindOf('git', ['log', '--oneline']) === 'read');
check('git commit counts as a write', agentrepo.kindOf('git', ['commit', '-m', 'x']) === 'write');
check('an unknown subcommand counts as a write, never a read', agentrepo.kindOf('git', ['bisect']) === 'write');
check('git config --get is a read', agentrepo.kindOf('git', ['config', '--get', 'user.name']) === 'read');
check('git config that sets is a write', agentrepo.kindOf('git', ['config', 'user.name', 'x']) === 'write');
check('cat is a read, write is a write, path is neither', agentrepo.kindOf('cat') === 'read' && agentrepo.kindOf('write') === 'write' && agentrepo.kindOf('path') === 'meta');

// A clean log, then three runs staged by hand: one that ignored the repo entirely, one
// that wrote without ever looking, and one that looked first.
fs.rmSync(USAGE_LOG, { force: true });
const say = (run, arm, verb, kind) =>
  agentrepo.record({ workspace: 'w', agent: 'advocate', run, arm, verb, kind, target: 'x' });
const say2 = (run, arm, verb, kind) =>
  agentrepo.record({ workspace: 'w', agent: 'worker', run, arm, verb, kind, target: 'x' });

say('a', 'blind', 'session', 'meta');
say('b', 'blind', 'session', 'meta');
say('b', 'blind', 'write', 'write');
say('b', 'blind', 'git', 'write');
say('c', 'index', 'session', 'meta');
say('c', 'index', 'cat', 'read');
say('c', 'index', 'write', 'write');

const all = agentrepo.summaryByAgent();
const s = all.advocate;
check('a run that ignored the repo is still a run', s.blind.runs === 2, JSON.stringify(s.blind));
check('…and is not counted as having touched it', s.blind.touched === 1);
check('wrote without reading is counted as a write and not a read', s.blind.wrote === 1 && s.blind.read === 0);
check('readFirst is zero for the blind arm here', s.blind.readFirst === 0);
check('the index arm read before it wrote', s.index.runs === 1 && s.index.readFirst === 1);
check('and is counted in both columns', s.index.read === 1 && s.index.wrote === 1);
check('the numbers are keyed by agent, not pooled across them', Object.keys(all).join() === 'advocate');

// bc-goo.12: the defect that mattered the moment a second agent kind started recording.
// Two runs of the worker on top of the advocate's three, in the same arm — a pooled
// `blind.runs` would read 4 and belong to neither of them.
say2('w1', 'blind', 'session', 'meta');
say2('w1', 'blind', 'write', 'write');
say2('w2', 'index', 'session', 'meta');
const two = agentrepo.summaryByAgent();
check('a second agent kind gets its own bucket', two.worker.blind.runs === 1 && two.worker.index.runs === 1);
check('…and the first agent\'s numbers are untouched by it', two.advocate.blind.runs === 2 && two.advocate.index.runs === 1);
check('an unknown agent id never invents a bucket of its own', !Object.keys(two).includes(''));
check('an agent that never ran is still named when it is expected', 'epic-advocate' in agentrepo.summaryByAgent({ expect: ['epic-advocate'] }));

/* ---------------------------------------------- saying it out loud */

// The whole of bc-goo.12: `readFirst 0` is the result the prediction expects AND what an
// arm that has never run says, so an arm with no runs must never print a number.
const text = agentrepo.report(two, { expect: ['advocate', 'worker', 'epic-advocate'] });
check('an agent that owns a repo and has never run is named anyway', /epic-advocate\n\s+NOTHING HAS EVER RUN/.test(text));
check('an arm with runs prints its numbers', /blind\s+runs 2\s+touched 1/.test(text));
check('the report says which comparisons cannot be computed', /cannot be computed for: epic-advocate/.test(text));

const both = {
  worker: { blind: { runs: 2, touched: 1, read: 1, wrote: 1, readFirst: 1, commands: 3 }, index: { runs: 2, touched: 2, read: 2, wrote: 1, readFirst: 2, commands: 5 } },
};
const full = agentrepo.report(both, { expect: ['worker'] });
check('an arm with no data never prints a zero', !/NO DATA/.test(full));
check('…and a computable comparison says so', /computable for all of them/.test(full));

const empty = agentrepo.report({}, { expect: ['worker'] });
check('an empty log is a sentence rather than a table of zeroes', /NOTHING HAS EVER RUN/.test(empty) && !/runs 0/.test(empty));

// bc-goo.6, the first time this report was read for its answer: both arms full, and the
// comparison still empty. Nothing had ever been written, so `index` had only ever had
// "It is empty" to list — the arms differed by one sentence and by no information, and
// `readFirst 0` under `index` is then a treatment that was never applied.
const untouched = {
  worker: { blind: { runs: 14, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 }, index: { runs: 13, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 } },
};
const flat = agentrepo.report(untouched, { expect: ['worker'] });
check('both arms full and never written to is not a comparison', /have not yet differed for: worker/.test(flat));
check('…and it must not be reported as computable', !/computable for all of them/.test(flat));
check('…and the numbers are still printed, because the runs are real', /blind\s+runs 14/.test(flat) && /index\s+runs 13/.test(flat));

// One write in either arm is enough: it is content in the repo, so the next `index` run
// has a listing to be shown. `blind` is the arm that puts it there as often as not.
const wroteBlind = {
  worker: { blind: { runs: 3, touched: 1, read: 0, wrote: 1, readFirst: 0, commands: 1 }, index: { runs: 3, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 } },
};
check('a write in the blind arm alone still differentiates them', !/have not yet differed/.test(agentrepo.report(wroteBlind, { expect: ['worker'] })));

// An arm with no runs is the louder problem and already says so; naming the same agent
// twice would be two sentences that disagree about which half of it is missing.
const oneArm = {
  advocate: { blind: { runs: 1, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 }, index: { runs: 0, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 } },
};
const half = agentrepo.report(oneArm, { expect: ['advocate'] });
check('a starved agent is not also reported as undifferentiated', /cannot be computed for: advocate/.test(half) && !/have not yet differed/.test(half));

check('the usage log is owner-only', (fs.statSync(USAGE_LOG).mode & 0o077) === 0);
check('the log lives beside the repos, never inside one', !USAGE_LOG.startsWith(`${dir}${path.sep}`));

// A torn line must not take the report down with it — this file is appended to by every
// wrapper invocation and read by a screen.
fs.appendFileSync(USAGE_LOG, '{"run":"d","ar\n');
check('a torn append is dropped, not thrown', agentrepo.summary({ agent: 'advocate' }).blind.runs === 2);

/* -------------------------------------------------------------- the arms */

console.log('\nthe arms');

check('off means no repo and no grant', agentrepo.armFor('w', 'advocate', 'off') === null);
check('an explicit arm is honoured', agentrepo.armFor('w', 'advocate', 'index') === 'index');
// Two blind runs and one index run are on the log above, so alternate is owed an index.
check('alternate picks the arm with fewer runs', agentrepo.armFor('w', 'advocate', 'alternate') === 'index');
check('a workspace with no runs starts blind, which is the arm the prediction is about', agentrepo.armFor('elsewhere', 'advocate', 'alternate') === 'blind');

/* ------------------------------------------------------------- the brief */

console.log('\nthe brief');

const index = await agentrepo.indexOf('beadcause', 'advocate');
check('the index sees the working tree', index.files.some((f) => f.name === 'notes.md'));
check('and the commits', index.commits.length === 1 && /what I noticed/.test(index.commits[0].subject));

const blindBrief = agentrepo.repoBrief(index, { arm: 'blind', owner: 'Adam' });
const indexBrief = agentrepo.repoBrief(index, { arm: 'index', owner: 'Adam' });
check('both arms name the command', /beadcause-agentrepo write/.test(blindBrief) && /beadcause-agentrepo write/.test(indexBrief));
check('only the index arm says what is in there — that difference IS the experiment', !/notes\.md/.test(blindBrief) && /notes\.md/.test(indexBrief));
check('the index arm shows the commits too', /what I noticed/.test(indexBrief));

const emptyBrief = agentrepo.repoBrief({ exists: true, files: [], commits: [] }, { arm: 'index', owner: 'Adam' });
check('an empty repo says so rather than showing a blank list', /It is empty/.test(emptyBrief));

/* ---------------------------------------------------------- the wiring */

console.log('\nthe wiring');

const foundation = await import('../lib/foundation.js');
check('ownsRepo may never be amended', foundation.PROTECTED.includes('ownsRepo'));
check('…and is not in the amendable set', !foundation.AMENDABLE.includes('ownsRepo'));
// bc-goo.12: three agents, not one. The advocate alone was a survey behind a twelve-hour
// cooldown and an unanswered-proposal gate — one recorded run in four days, all of it in
// one arm, and a comparison that could not be computed.
for (const owns of ['advocate', 'epic-advocate', 'worker']) {
  check(`${owns} owns a repo`, foundation.baseline(owns).ownsRepo === true);
}
for (const other of ['console', 'dispatch']) {
  check(`${other} does not — it answers one turn and has nothing to keep`, foundation.baseline(other).ownsRepo === false);
}

const grant = agentrepo.grantsFor(foundation.baseline('advocate'), 'beadcause', { arm: 'index', run: 'zz' });
check('the grant is one allowlist entry', grant.allowedTools.length === 1 && grant.allowedTools[0] === 'Bash(beadcause-agentrepo:*)');
check('and it points at this agent\'s own directory', grant.env.BEADCAUSE_AGENT_REPO === dir);
check('the arm and the run ride in the environment', grant.env.BEADCAUSE_AGENT_REPO_ARM === 'index' && grant.env.BEADCAUSE_AGENT_REPO_RUN === 'zz');
check('an agent without ownsRepo gets nothing', agentrepo.grantsFor(foundation.baseline('console'), 'beadcause') === null);
check('…and neither does it get a run', (await agentrepo.startRun(foundation.baseline('console'), 'beadcause')) === null);
check('nor does any agent when the setting is off', (await agentrepo.startRun(foundation.baseline('worker'), 'beadcause', { setting: 'off' })) === null);

// `startRun` is the one composer all three doors go through, and the order inside it is
// what the denominator depends on: the run is recorded at spawn, before the agent has had
// a chance to touch anything.
const before = agentrepo.summary({ agent: 'worker' }).index.runs;
const started = await agentrepo.startRun(foundation.baseline('worker'), 'beadcause', { setting: 'index', owner: 'Adam' });
check('a started run carries its arm, its grant and its brief', started.arm === 'index' && /beadcause-agentrepo write/.test(started.brief));
check('the grant points at this agent\'s own directory', started.grant.env.BEADCAUSE_AGENT_REPO === agentrepo.repoDir('beadcause', 'worker'));
check('and the run is in the denominator before the agent does anything', agentrepo.summary({ agent: 'worker' }).index.runs === before + 1);

// `agentEnv` spreads `extra` after `foundation.env`, which is what stops an amended env
// repointing the wrapper. Worth an assertion rather than a comment: the ordering is one
// spread away from being the other way round.
const f = foundation.baseline('advocate');
f.env = { BEADCAUSE_AGENT_REPO: '/tmp/somewhere-else' };
check(
  'an amended env cannot repoint the wrapper',
  foundation.agentEnv(f, grant.env).BEADCAUSE_AGENT_REPO === dir
);

// The other half of bc-goo.12: the grant has to reach a window, not just exist. Both
// session doors go through `launch`, which is not exported — what is exported is the line
// it hands AppleScript, and that line is where an env that did not survive the hop shows
// up. iTerm starts a fresh login shell that inherits nothing from the daemon, so an
// environment that is not in this string does not exist for the agent.
const { sessionCommand } = await import('../lib/session.js');
const workerRun = await agentrepo.startRun(foundation.baseline('worker'), 'beadcause', { setting: 'blind' });
const workerF = foundation.baseline('worker');
workerF.allowedTools = [...(workerF.allowedTools || []), ...workerRun.grant.allowedTools];
const line = sessionCommand(workerF, {
  dir: CONFIG,
  promptFile: '/tmp/p.md',
  systemFile: '/tmp/s.md',
  mode: 'auto',
  env: workerRun.grant.env,
});
check('the worker window exports the repo it owns', line.includes(`export BEADCAUSE_AGENT_REPO='${workerRun.grant.dir}'`));
check('…and the arm and run it is being measured under', /BEADCAUSE_AGENT_REPO_ARM='blind'/.test(line) && /BEADCAUSE_AGENT_REPO_RUN=/.test(line));
check('…and may run the wrapper without being asked', /--allowedTools .*beadcause-agentrepo/.test(line));
check('a session with no grant exports none of it', !/BEADCAUSE_AGENT_REPO/.test(sessionCommand(foundation.baseline('worker'), { dir: CONFIG, promptFile: '/tmp/p.md' })));

const commonrepo = await import('../lib/commonrepo.js');
// The regression that matters is the *existing* install: the ignore file is written once,
// before `git init`, and a rule added afterwards only ever protected fresh directories
// until `topUpIgnore` existed.
const ignore = path.join(CONFIG, '.gitignore');
fs.writeFileSync(ignore, '# an install that predates tier 3\nstatus.json\n');
await commonrepo.ensureRepo();
check('agents/ is added to an ignore file that predates it', /^agents\/$/m.test(fs.readFileSync(ignore, 'utf8')));
check('and the hand-written line above it survives', /status\.json/.test(fs.readFileSync(ignore, 'utf8')));

// The failure this actually prevents: `git add -A` in the config dir pulling an agent's
// private files into a shared history. Checked against git rather than against the regex,
// because the question is what git does and not what the file says.
const ignored = spawnSync('git', ['check-ignore', '-q', path.relative(CONFIG, path.join(dir, 'notes.md'))], { cwd: CONFIG });
check('git itself refuses to see inside an agent repo', ignored.status === 0);

/* ------------------------------------------------------------------ end */

await cleanupTmp(CONFIG);

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
assert.equal(failures, 0, `${failures} check(s) failed`);
