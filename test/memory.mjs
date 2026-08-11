#!/usr/bin/env node
//
// The common repo and the memory API.
//
//   npm test                       (runs it alongside the other suites)
//   node test/memory.mjs           (on its own)
//
// Three things are worth a test here and the rest is plumbing:
//
// 1. **The signing key must not get committed.** ~/.config/beadcause holds
//    android-keystore.jks. A `git init && git add -A` there puts a release key in a
//    history, and a key in a history is a key you have to rotate. So: the ignore
//    file exists before the repo does, and the commit refuses even when something
//    has forced the file into the index anyway.
// 2. **Two writers must not lose each other's message.** The blackboard's whole
//    reason for being on a ref is the compare-and-swap, and a CAS you have not
//    raced is a CAS you have not tested — so six processes post to one topic at
//    once and every sequence number has to be there exactly once.
// 3. **A memory has to outlive the process that wrote it**, and one agent's memory
//    must not overwrite another's — which is what the whole-tree rebuild in
//    `remember` is for, and the thing a naive `mktree` gets silently wrong.
// 4. **A note about a repo has to reach a session that is not in the same worktree.**
//    Nearly all work here happens in a worktree that is retired days later, so tier 1
//    is worth nothing unless a note written from one is visible from the main checkout
//    and from every sibling — and it must not be visible from a *different* repo, which
//    is the whole reason the tier exists. Both are properties of where the ref lives,
//    and neither is asserted by anything else.
//
// The tier-2 half runs against a temp BEADCAUSE_CONFIG_DIR; the tier-1 half runs
// against throwaway git repos with real linked worktrees. Nothing here touches the
// real ~/.config/beadcause or any repo you work in, and nothing pushes anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- child mode */
//
// `--post <topic> <message>` posts once and exits. That is how the concurrency case
// gets six genuinely separate writers: same code, same store, six processes, no
// shared memory to accidentally serialise them.
//
// `--note <key> <value>` is the tier-1 twin, and it has to be a child process rather
// than a loop: tier 1 resolves its store from `process.cwd()`, so "two worktrees
// writing at once" is only real if the two writers are in two directories, and one
// process has one cwd.

if (process.argv[2] === '--post') {
  const [, , , topic, ...message] = process.argv;
  const { post } = await import('../lib/memory.js');
  await post(topic, message.join(' '));
  process.exit(0);
}

if (process.argv[2] === '--note') {
  const [, , , key, ...value] = process.argv;
  const { note } = await import('../lib/memory.js');
  await note(process.env.BEADCAUSE_AGENT || 'worker', key, value.join(' '));
  process.exit(0);
}

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
    bad(name, 'it resolved, and should not have');
  } catch (err) {
    check(name, match.test(err.message), err.message);
  }
};

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-memory-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
process.env.BEADCAUSE_AGENT = 'advocate';
process.on('exit', () => fs.rmSync(store, { recursive: true, force: true }));

const git = (...args) => execFileSync('git', ['-C', store, ...args], { encoding: 'utf8' }).trim();

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { ensureRepo, commit, snapshot, flush, history } = await import('../lib/commonrepo.js');
const memory = await import('../lib/memory.js');

/* ------------------------------------------------------ the common repo */

console.log('the common repo');

await ensureRepo();
check('git init happened', fs.existsSync(path.join(store, '.git')));
check('.gitignore was written', fs.existsSync(path.join(store, '.gitignore')));
check(
  '.gitignore predates the repo — no commit exists yet that could have caught a key',
  git('log', '--oneline', '--all') === ''
);

fs.writeFileSync(path.join(store, 'android-keystore.jks'), 'PRETEND SIGNING KEY');
fs.writeFileSync(path.join(store, 'android-keystore.properties'), 'storePassword=hunter2');
fs.writeFileSync(path.join(store, 'loupe-sophab.png'), 'PRETEND PNG');
fs.writeFileSync(path.join(store, 'status.json'), '{}');
fs.mkdirSync(path.join(store, 'logs'), { recursive: true });
fs.writeFileSync(path.join(store, 'logs', 'run.log'), 'noise');
fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ token: 'abc' }, null, 2) + '\n');

const first = await commit('config');
check('a first snapshot lands', typeof first === 'string' && first.length === 40, String(first));

const tracked = git('ls-files').split('\n').filter(Boolean);
check('config.json is tracked', tracked.includes('config.json'), tracked.join(' '));
check('the signing key is NOT tracked', !tracked.some((f) => f.includes('keystore')), tracked.join(' '));
check('the check PNG is not tracked', !tracked.includes('loupe-sophab.png'), tracked.join(' '));
check('status.json churn is not tracked', !tracked.includes('status.json'), tracked.join(' '));
check('logs/ is not tracked', !tracked.some((f) => f.startsWith('logs/')), tracked.join(' '));

check('an unchanged directory produces no commit', (await commit('nothing')) === null);

// The belt-and-braces case: someone forced the key into the index anyway — an edited
// .gitignore, a `git add -f`, a stray `git add` from a shell in that directory.
git('add', '-f', 'android-keystore.jks');
await rejects('a staged signing key aborts the commit', () => commit('oops'), /refusing to commit/i);
check('and it is unstaged again, so the next commit cannot pick it up', git('diff', '--cached', '--name-only') === '');

fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ token: 'def' }, null, 2) + '\n');
snapshot('config', { delayMs: 0 });
await flush();
const log = await history();
check('the history shows both versions', log.length === 2, JSON.stringify(log.map((c) => c.subject)));
check(
  'and the previous config is recoverable from it',
  JSON.parse(git('show', `${log[1].commit}:config.json`)).token === 'abc'
);

/* ------------------------------------------- and the state writes use it */
//
// The history is worth nothing if the writes do not take it, and the wiring is easy
// to get wrong in a way that fails silently — lib/config.js and lib/commonrepo.js
// import each other, so a snapshot call placed where the module cycle has not
// resolved would throw inside a `try` somewhere and simply stop recording.

console.log('\nthe state writes take a snapshot');

const cfg = await import('../lib/config.js');
cfg.saveConfig({ token: 'first', workspaces: [] });
cfg.saveState({ notified: ['bc-1'] });
await flush();

const wired = await history();
check('a config write is committed', wired.some((c) => c.subject.includes('config')), JSON.stringify(wired.map((c) => c.subject)));
check('and so is a state write', wired.some((c) => c.subject.includes('state')), JSON.stringify(wired.map((c) => c.subject)));
check(
  'both in one commit — bursts are debounced, not one commit per write',
  wired[0].subject === 'config, state',
  wired[0].subject
);

cfg.saveConfig({ token: 'second', workspaces: [] });
await flush();
check('a later write is a new commit', (await history())[0].commit !== wired[0].commit);
check(
  'and the previous token is recoverable',
  JSON.parse(git('show', `${wired[0].commit}:config.json`)).token === 'first'
);

/* ------------------------------------------------------------- remembering */

console.log('\nremembering');

await memory.remember('advocate', 'tone', 'evidence first, then the ask');
check('a memory reads back', (await memory.recall('advocate', 'tone')) === 'evidence first, then the ask');
check('a key that was never written is null', (await memory.recall('advocate', 'nothing')) === null);

await memory.remember('console', 'shape', 'one bead per decision');
check(
  "another agent's write does not clobber the first",
  (await memory.recall('advocate', 'tone')) === 'evidence first, then the ask'
);
check('and its own reads back', (await memory.recall('console', 'shape')) === 'one bead per decision');

await memory.remember('advocate', 'tone', 'evidence first, and name the file');
check('a rewrite wins', (await memory.recall('advocate', 'tone')) === 'evidence first, and name the file');
check(
  'and the old value is still in the ref history',
  git('log', '--format=%s', 'refs/beadcause/memory').split('\n').length === 3,
  git('log', '--format=%s', 'refs/beadcause/memory')
);

await memory.remember('advocate', 'threshold', { proposals: 3, quiet: true });
const all = await memory.recall('advocate');
check('recall with no key returns every value, unwrapped', all.threshold.proposals === 3, JSON.stringify(all));
check('and it does not leak the storage envelope', all.tone === 'evidence first, and name the file');
check('agents() lists who has memory', (await memory.agents()).join(',') === 'advocate,console', String(await memory.agents()));

const detail = await memory.recallDetail('advocate');
check('recallDetail keeps the timestamp', typeof detail.tone.at === 'string' && detail.tone.at.endsWith('Z'));

await rejects('a bad agent name is rejected, not sanitised', () => memory.remember('advocate/sophab', 'k', 'v'), /bad agent/);
await rejects('and so is one that walks up a directory', () => memory.remember('..', 'k', 'v'), /bad agent/);
await rejects('a bad key too', () => memory.remember('advocate', 'a key', 'v'), /bad key/);

// The memory has to survive the process, which is the entire point of it.
const other = await run(process.execPath, ['-e', "const m = await import('./lib/memory.js'); process.stdout.write(String(await m.recall('advocate','tone')))"], {
  cwd: path.join(HERE, '..'),
  env: process.env,
});
check('a different process recalls it', other.stdout === 'evidence first, and name the file', other.stdout);

/* ------------------------------------------------------------ the blackboard */

console.log('\nthe blackboard');

const one = await memory.post('proposals', 'the graph work is blocked on a decision');
check('the first message is #1', one.seq === 1, JSON.stringify(one));
check('and it is attributed to whoever posted it', one.from === 'advocate', one.from);

await memory.post('proposals', 'seen — I will not re-file it', { from: 'console' });
const both = await memory.read('proposals');
check('both messages come back', both.length === 2, JSON.stringify(both.map((m) => m.seq)));
check('oldest first', both[0].seq === 1 && both[1].seq === 2);
check('with the other agent named', both[1].from === 'console', both[1].from);

const fresh = await memory.read('proposals', 1);
check('since skips what you have already seen', fresh.length === 1 && fresh[0].seq === 2, JSON.stringify(fresh));
check('since the last one is empty', (await memory.read('proposals', 2)).length === 0);
check('an ISO since works too', (await memory.read('proposals', both[0].at)).length === 1);
check('a topic nobody has posted to is empty, not an error', (await memory.read('silence')).length === 0);
check('topics lists it', (await memory.topics()).includes('proposals'), String(await memory.topics()));

await rejects('an empty message is refused', () => memory.post('proposals', '   '), /nothing to post/);
await rejects('a bad topic is refused', () => memory.post('a topic', 'x'), /bad topic/);

/* ----------------------------------------------- the path an agent takes */
//
// The library is for the daemon. An agent is a `claude -p` in a login shell with an
// allowlist, so its whole reach to any of this is the command — and every link in
// that chain is something that can silently not be there: the binary not on PATH,
// the identity not exported, the tool not on the allowlist. Each of those fails as
// "the agent just didn't use it", which is indistinguishable from it choosing not
// to. So the chain gets walked here exactly as the agent walks it.

console.log('\nthe path an agent actually takes');

const { effective, agentEnv } = await import('../lib/foundation.js');
const consoleF = await effective(path.join(HERE, '..'), 'console');
const env = agentEnv(consoleF, { BEADCAUSE_CONFIG_DIR: store });

check(
  'the tool is on the console\'s allowlist',
  consoleF.allowedTools.includes('Bash(beadcause-memory:*)'),
  consoleF.allowedTools.join(' ')
);
check('and the spawner stamps who it is', env.BEADCAUSE_AGENT === 'console', String(env.BEADCAUSE_AGENT));

// A login shell, because that is what every agent here is spawned through — and
// ~/.zshenv rebuilding PATH would be exactly the sort of thing that quietly breaks
// this.
await run('/bin/zsh', ['-lc', 'beadcause-memory remember shape "one bead per decision, always"'], { env });
check(
  'the agent wrote to its own memory, by name, without naming itself',
  (await memory.recall('console', 'shape')) === 'one bead per decision, always'
);

const back = await run('/bin/zsh', ['-lc', 'beadcause-memory recall shape'], { env });
check('and reads it back in a later run', back.stdout.trim() === 'one bead per decision, always', back.stdout);

// The identity is stamped after `env`, so an amendment that set BEADCAUSE_AGENT
// cannot make one agent write as another.
const impostor = agentEnv({ ...consoleF, env: { BEADCAUSE_AGENT: 'advocate' } }, { BEADCAUSE_CONFIG_DIR: store });
check('an amended env cannot change who the agent is', impostor.BEADCAUSE_AGENT === 'console', impostor.BEADCAUSE_AGENT);

/* --------------------------------------- reading another agent, and only reading */
//
// The console reading the advocate's memory is the whole point of `--of`, and the
// whole risk of it: the flag that lets you *read* another agent must not be a flag
// that lets you *write* as one. `--agent` already does the second thing — it is
// documented as a human's debugging aid — so the test that matters is that the two
// stayed different, in the direction that costs something if it drifts.

console.log('\nreading another agent, and only reading');

const zsh = (line, e = env) => run('/bin/zsh', ['-lc', line], { env: e });

const roster = await zsh('beadcause-memory agents');
check(
  'the roster lists every kind that has a memory',
  roster.stdout.trim().split('\n').sort().join(',') === 'advocate,console',
  roster.stdout
);

const theirs = await zsh('beadcause-memory recall --of=advocate tone');
check(
  "the console reads the advocate's memory",
  theirs.stdout.trim() === 'evidence first, and name the file',
  theirs.stdout
);
check(
  'and stdout is only the value — the provenance note is on stderr, so a $( ) capture is unchanged',
  theirs.stdout === 'evidence first, and name the file\n' && /notes to itself/.test(theirs.stderr),
  JSON.stringify({ out: theirs.stdout, err: theirs.stderr })
);

const listed = await zsh('beadcause-memory recall --of=advocate');
check(
  'with no key it lists what they know',
  listed.stdout.includes('threshold') && listed.stdout.includes('tone'),
  listed.stdout
);

const ownRecall = await zsh('beadcause-memory recall shape');
check(
  'reading your own carries no such note — it is nobody else\'s to warn about',
  !/notes to itself/.test(ownRecall.stderr),
  ownRecall.stderr
);

// The acceptance case: `--of` on a command that writes is refused outright, rather
// than being quietly read as "and while you are there, be them".
const before = await memory.recall('advocate', 'tone');
let combined;
try {
  await zsh('beadcause-memory remember --of=advocate tone "the console got in"');
  combined = null;
} catch (err) {
  combined = err;
}
check('remember --of is refused', combined !== null && combined.code !== 0, String(combined));
check(
  'and it says why',
  combined !== null && /cannot be combined with `remember`/.test(String(combined.stderr)),
  String(combined?.stderr)
);
check(
  "and the advocate's memory is untouched",
  (await memory.recall('advocate', 'tone')) === before,
  String(await memory.recall('advocate', 'tone'))
);

let posted;
try {
  await zsh('beadcause-memory post --of=advocate proposals "as them"');
  posted = null;
} catch (err) {
  posted = err;
}
check('post --of is refused too — the guard is on writing, not on one command', posted !== null, String(posted));

// A read attributes to nobody, so it needs no identity — which is also what stops
// `--of` from being a back door into a write: there is no author to borrow.
const anonymous = { ...env };
delete anonymous.BEADCAUSE_AGENT;
const nameless = await zsh('beadcause-memory recall --of=advocate tone', anonymous);
check('a caller with no identity can still read', nameless.stdout.trim() === before, nameless.stdout);

let namelessWrite;
try {
  await zsh('beadcause-memory remember tone "no identity, no write"', anonymous);
  namelessWrite = null;
} catch (err) {
  namelessWrite = err;
}
check('but still cannot write', namelessWrite !== null && /no agent/.test(String(namelessWrite.stderr)), String(namelessWrite?.stderr));

let bareOf;
try {
  await zsh('beadcause-memory recall --of');
  bareOf = null;
} catch (err) {
  bareOf = err;
}
check(
  '--of with no name is an error, not silently your own memory',
  bareOf !== null && /--of=<agent>/.test(String(bareOf.stderr)),
  String(bareOf?.stderr)
);

/* --------------------------------------------- notes, about one repo only */
//
// Tier 1. Everything below is a property of *where the ref lives*, and none of it is
// asserted anywhere else — so a refactor that quietly resolved the store from
// somewhere other than the working repo would pass every other suite in the tree.
//
// The two that matter most are opposites, and both are about a boundary:
//
// - a note written in a worktree has to be readable from the main checkout and from
//   every sibling worktree, because nearly all work here happens in a worktree that is
//   retired days later and a note that died with it would be worse than none;
// - the same key in another repo has to be a *different* note, because if it is not
//   then this is tier 2 with extra steps and the knowledge it exists to hold — how one
//   codebase is put together — is false somewhere the moment it is written.
//
// Real `git worktree add` worktrees, in throwaway repos, because the shared-ref-store
// property being relied on is git's and not ours.

console.log('\nnotes about one repo, from any worktree of it');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tier1-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/** A throwaway repo with one commit, so `git worktree add` has something to branch. */
function repo(id) {
  const dir = path.join(scratch, id);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
      encoding: 'utf8',
    }).trim();
  g('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'README'), `${id}\n`);
  // As the real thing does: worktrees live under `.claude/` inside the repo, so the repo
  // ignores it. Without this the untracked worktree directories are the only thing `git
  // status` reports, which is the check below asking about the wrong noise.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  // Under .claude/worktrees/, exactly where this repo puts its own — so the layout being
  // tested is the layout in use, including a worktree nested inside its parent.
  const worktree = (wt) => {
    const at = path.join(dir, '.claude', 'worktrees', wt);
    g('worktree', 'add', '-q', at, '-b', `worktree-${wt}`);
    return at;
  };
  return { dir, git: g, worktree };
}

/**
 * Run something with the process standing somewhere else.
 *
 * `process.chdir` and not a `dir` argument, because there is no `dir` argument — which
 * is the point of the tier and is asserted below. The restore is in a `finally` so one
 * failed check cannot leave every later suite resolving against a temp directory that
 * is about to be deleted.
 */
const at = async (dir, fn) => {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(back);
  }
};

const alpha = repo('alpha');
const beta = repo('beta');
const wtOne = alpha.worktree('one-a3f');
const wtTwo = alpha.worktree('two-b7c');

const LAYOUT = 'lib/ is the daemon, bin/ is what an agent can run';
await at(wtOne, () => memory.note('worker', 'layout', LAYOUT));

check(
  'a note written in a worktree is there from the main checkout',
  (await at(alpha.dir, () => memory.notes('worker', 'layout'))) === LAYOUT
);
check(
  'and from a sibling worktree that never wrote it',
  (await at(wtTwo, () => memory.notes('worker', 'layout'))) === LAYOUT
);
check(
  'it lives on a ref in that repo',
  alpha.git('log', '--format=%s', 'refs/beadcause/agents/worker') === `note worker.layout: ${LAYOUT}`,
  alpha.git('log', '--format=%s', 'refs/beadcause/agents/worker')
);
// The invisibility claim, checked as stated and not more broadly: `git log` and `git
// branch` do not see it. `git log --all` *does* — `--all` means every ref under `refs/`,
// not every branch — and that is worth knowing rather than asserting away, because it is
// how you find these commits by accident and how `gc` keeps them.
check(
  'and is invisible to plain log and to branch',
  alpha.git('log', '--oneline').split('\n').length === 1 &&
    !alpha.git('branch', '--all').includes('beadcause'),
  `${alpha.git('log', '--oneline')} | ${alpha.git('branch', '--all')}`
);
check(
  'and the repo has no new tracked file, in any worktree',
  alpha.git('status', '--porcelain') === '' &&
    execFileSync('git', ['-C', wtOne, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
  alpha.git('status', '--porcelain')
);

check(
  'another repo has never heard of the key',
  (await at(beta.dir, () => memory.notes('worker', 'layout'))) === null
);
await at(beta.dir, () => memory.note('worker', 'layout', 'one flat module, no daemon'));
check(
  'and the same key there holds its own value',
  (await at(beta.dir, () => memory.notes('worker', 'layout'))) === 'one flat module, no daemon'
);
check(
  "while alpha's is untouched — this is the whole reason the store is in the repo",
  (await at(alpha.dir, () => memory.notes('worker', 'layout'))) === LAYOUT
);

await at(wtOne, () => memory.note('worker', 'tests', { runner: 'scripts/test.mjs', discovers: 'test/*.mjs' }));
const noted = await at(alpha.dir, () => memory.notes('worker'));
check('notes with no key returns every value, unwrapped', noted.tests.runner === 'scripts/test.mjs', JSON.stringify(noted));
check('and does not leak the storage envelope', noted.layout === LAYOUT, JSON.stringify(noted));
const noteDetail = await at(alpha.dir, () => memory.notesDetail('worker'));
check('notesDetail keeps the timestamp', typeof noteDetail.layout.at === 'string' && noteDetail.layout.at.endsWith('Z'));
check(
  'a rewrite wins and the old value stays in the ref history',
  (await at(wtTwo, async () => {
    await memory.note('worker', 'layout', `${LAYOUT}, and scripts/ is neither`);
    return memory.notes('worker', 'layout');
  })) === `${LAYOUT}, and scripts/ is neither` &&
    alpha.git('log', '--format=%s', 'refs/beadcause/agents/worker').split('\n').length === 3,
  alpha.git('log', '--format=%s', 'refs/beadcause/agents/worker')
);

check(
  "one agent's notes do not clobber another's — a ref each, not a file each",
  (await at(alpha.dir, async () => {
    await memory.note('advocate', 'layout', 'the advocate reads lib/advocate.js and nothing else');
    return memory.notes('worker', 'layout');
  })) === `${LAYOUT}, and scripts/ is neither`
);

await rejects(
  'a bad agent name is rejected here too, not sanitised',
  () => at(alpha.dir, () => memory.note('worker/beta', 'k', 'v')),
  /bad agent/
);
await rejects('and a bad key', () => at(alpha.dir, () => memory.note('worker', 'a key', 'v')), /bad key/);

// A directory outside any repo is a caller in the wrong place, not an agent that knows
// nothing — so it says so, in both directions. `scratch` holds the repos and is not one.
await rejects('a write outside a repo says where it was', () => at(scratch, () => memory.note('worker', 'k', 'v')), /not in a git repo/);
await rejects('and so does a read', () => at(scratch, () => memory.notes('worker', 'k')), /not in a git repo/);

/* ------------------------------------- and no way to name the repo yourself */
//
// The indirection is the feature, and the way it dies is one caller being handed a path
// "just for this case". Both halves are checked: the API takes no directory, and the CLI
// has no flag for one — including the plausible-looking flags somebody would reach for,
// which are silently ignored rather than quietly honoured.

check(
  'no tier-1 call takes a directory',
  memory.note.length === 3 && memory.notes.length === 1 && memory.notesDetail.length === 1,
  `${memory.note.length} ${memory.notes.length} ${memory.notesDetail.length}`
);

const usage = (await run(process.execPath, [path.join(HERE, '..', 'bin', 'beadcause-memory')])).stdout;
check('and the CLI offers no flag for one', !/--(repo|dir|path|cwd|workspace)/.test(usage), usage);

const cli = (line, cwd, e = env) => run('/bin/zsh', ['-lc', line], { env: e, cwd });

await cli('beadcause-memory note owner "the console posts, the worker notes" --repo=/nowhere', wtOne);
check(
  'a --repo nobody implemented is ignored, not honoured',
  (await at(alpha.dir, () => memory.notes('console', 'owner'))) === 'the console posts, the worker notes' &&
    (await at(beta.dir, () => memory.notes('console', 'owner'))) === null
);

/* --------------------------------------- the path an agent takes to tier 1 */
//
// Same reasoning as the tier-2 walk above: the library is for the daemon, and an agent's
// entire reach is the command in a login shell. The extra link here is the *directory* —
// an agent is spawned in its worktree, and that is what decides which repo it is talking
// about, so the walk has to be done from one.

const wrote = await cli('beadcause-memory note style "comments carry the reason, not the what"', wtOne);
check('the agent noted it against the repo it was standing in', /^noted console\.style in /.test(wrote.stdout.trim()), wrote.stdout);
const readBack = await cli('beadcause-memory notes style', alpha.dir);
check(
  'and reads it back from the main checkout in a later run',
  readBack.stdout.trim() === 'comments carry the reason, not the what',
  readBack.stdout
);

const missing = await cli('beadcause-memory notes style || echo none', beta.dir);
check('a miss in another repo is a non-zero exit, not a value', missing.stdout.trim() === 'none', missing.stdout);

const otherAgent = await cli('beadcause-memory notes --of=worker layout', wtTwo);
check(
  "--of reads another agent's notes on this repo",
  otherAgent.stdout.trim() === `${LAYOUT}, and scripts/ is neither`,
  otherAgent.stdout
);
check(
  'and still says whose notes they are, on stderr only',
  otherAgent.stdout === `${LAYOUT}, and scripts/ is neither\n` && /notes to itself/.test(otherAgent.stderr),
  JSON.stringify({ out: otherAgent.stdout, err: otherAgent.stderr })
);

let noteAs;
try {
  await cli('beadcause-memory note --of=worker layout "the console got in"', wtOne);
  noteAs = null;
} catch (err) {
  noteAs = err;
}
check(
  'note --of is refused — the guard is on writing, and it covers a verb added later',
  noteAs !== null && /cannot be combined with `note`/.test(String(noteAs.stderr)),
  String(noteAs?.stderr)
);
check(
  "and the worker's note is untouched",
  (await at(alpha.dir, () => memory.notes('worker', 'layout'))) === `${LAYOUT}, and scripts/ is neither`
);

/* ------------------------- two worktrees of one repo, writing at the same time */
//
// The case tier 1 actually meets: a dozen worker sessions in a dozen worktrees are one
// agent kind writing to one ref, and none of them knows the others exist. Distinct keys,
// so a lost race is a missing key rather than a value somebody has to reason about — and
// the whole notes object is rebuilt from the tip on every write, which is exactly what a
// lost CAS would silently undo.

console.log('\nsix processes noting into one repo, from two worktrees');

const SELF = fileURLToPath(import.meta.url);
const noters = Array.from({ length: 6 }, (_, i) =>
  run(process.execPath, [SELF, '--note', `k${i}`, `value ${i}`], {
    cwd: i % 2 ? wtOne : wtTwo,
    env: { ...process.env, BEADCAUSE_AGENT: 'racer' },
  })
);
const notedResults = await Promise.allSettled(noters);
const lost = notedResults.filter((r) => r.status === 'rejected');
check('every writer landed', lost.length === 0, lost.map((r) => r.reason?.message).join(' | '));

const raced1 = await at(alpha.dir, () => memory.notes('racer'));
check(
  'all six notes are there — nobody was overwritten',
  JSON.stringify(Object.keys(raced1).sort()) === JSON.stringify(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']),
  JSON.stringify(raced1)
);
check(
  'and the ref is one unbroken chain of six commits',
  alpha.git('log', '--format=%H', 'refs/beadcause/agents/racer').split('\n').filter(Boolean).length === 6
);
check(
  'the other repo saw none of it',
  Object.keys(await at(beta.dir, () => memory.notes('racer'))).length === 0
);

/* ------------------------------ and the brief says which store to write to */
//
// The acceptance case, and the one that decides whether any of the above gets used. A
// capability an agent has not been told about is one it does not have — `agents` shipped
// in the first version of the memory API and no agent ever ran it, because the brief
// listed four commands and not that one.
//
// A brief that describes one store while two exist is worse than one describing neither:
// the agent writes either way, into whichever it was told about. That is not
// hypothetical — it is what this text did while tier 1 did not exist, and "still true
// next week and in a different repo" was silently ruling out every fact about the
// codebase in front of it.

const brief = memory.memoryBrief('Adam');
check('the brief names the roster', brief.includes('beadcause-memory agents'), brief);
check('and tells them the read exists', brief.includes('--of=<agent>'), brief);
check('and that it is read-only', /only read theirs, never write it/.test(brief), brief);
check('the brief names both verbs of the repo-local store', /beadcause-memory note </.test(brief) && /beadcause-memory notes /.test(brief), brief);
check(
  'and gives the test for choosing between them',
  /would this still be true in a\s+different repo\?/.test(brief),
  brief
);
check(
  'saying what belongs in the one that follows the agent',
  brief.includes('**Yes — `remember`.**') && /approach that worked/.test(brief),
  brief
);
check(
  'and what belongs in the one that stays with the repo',
  brief.includes('**No — `note`.**') && brief.includes('*this* codebase is put together'),
  brief
);
check(
  'and what the cost of getting it wrong is, so the choice is not arbitrary',
  /advice\s+you will follow somewhere it is false/.test(brief) && /never see again once you are working elsewhere/.test(brief),
  brief
);

process.chdir(path.join(HERE, '..'));

/* ------------------------------------------------- six writers, one topic */

console.log('\nsix processes posting to one topic');

const posters = Array.from({ length: 6 }, (_, i) =>
  run(process.execPath, [SELF, '--post', 'race', `message ${i}`], { env: process.env })
);
const results = await Promise.allSettled(posters);
const failed = results.filter((r) => r.status === 'rejected');
check('every writer landed', failed.length === 0, failed.map((r) => r.reason?.message).join(' | '));

const raced = await memory.read('race', 0, { limit: 100 });
check('six messages are on the topic', raced.length === 6, JSON.stringify(raced.map((m) => m.seq)));
check(
  'with the sequence 1..6 exactly once each — nobody was overwritten',
  JSON.stringify(raced.map((m) => m.seq)) === JSON.stringify([1, 2, 3, 4, 5, 6]),
  JSON.stringify(raced.map((m) => m.seq))
);
check(
  'and the ref is one unbroken chain of six commits',
  git('log', '--format=%H', 'refs/beadcause/bus/race').split('\n').filter(Boolean).length === 6
);

/* ------------------------------------------------------------------ done */

console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
