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
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR. Nothing here touches the
// real ~/.config/beadcause, and nothing pushes anywhere.
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

if (process.argv[2] === '--post') {
  const [, , , topic, ...message] = process.argv;
  const { post } = await import('../lib/memory.js');
  await post(topic, message.join(' '));
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
  theirs.stdout === 'evidence first, and name the file\n' && /never a reason on its own/.test(theirs.stderr),
  JSON.stringify({ out: theirs.stdout, err: theirs.stderr })
);
// bc-pud4: the note says what the memory is *worth*, not that it was private. The
// rejected design was a curated readable subset, and "they never chose to publish
// this" was the sentence that pointed at it — so a regression to a privacy framing
// is a regression to a decision that was made and closed.
check(
  'and the note is about scrutiny, not about privacy',
  /must face scrutiny/.test(theirs.stderr) && !/not published to you|never chose to publish/.test(theirs.stderr),
  theirs.stderr
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
  !/never a reason on its own/.test(ownRecall.stderr),
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

// A capability an agent has not been told about is one it does not have. `agents`
// shipped in the first version and no agent ever ran it, for exactly this reason.
const brief = memory.memoryBrief('Adam');
check('the brief names the roster', brief.includes('beadcause-memory agents'), brief);
check('and tells them the read exists', brief.includes('--of=<agent>'), brief);
check('and that it is read-only', /only read theirs, never write it/.test(brief), brief);

// bc-pud4, the decision that closed the curated-subset question. Neither half of it
// is enforceable in code — one is what an agent expects of its readers, the other is
// what it does with what it reads — so the brief saying them *is* the mechanism, and
// these two checks are the only thing standing between the ruling and a silent
// revert. Both directions matter: the write half is why no second store was built.
check(
  'and the write half: expect to be read, because there is no private half',
  /Expect every other agent to read what you write/.test(brief) && /no private half/.test(brief),
  brief
);
check(
  'and the read half: never a reason on its own, and it faces scrutiny',
  /can never\s+be your reason/.test(brief) && /scrutiny/.test(brief),
  brief
);

/* ------------------------------------------------- six writers, one topic */

console.log('\nsix processes posting to one topic');

const SELF = fileURLToPath(import.meta.url);
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
