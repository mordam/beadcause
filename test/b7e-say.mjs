#!/usr/bin/env node
//
// `b7e-say` — agent prose goes into a bead or a memory from a file, never a shell argument.
//
//   npm test
//   node test/b7e-say.mjs
//
// bc-gdub.2: `beadcause-memory debrief/note/remember`, `bin/checkin.js -m` and three of
// `bin/deliver.js`'s flags all took the text a session wanted to say as an argv token,
// which forced a session to embed backticked prose directly inside a Bash tool call's
// double-quoted command string — and bash resolves those backticks as command
// substitution before the wrapped command ever runs. Five sessions hand-rolled a
// scratch-file workaround around exactly that. This is the command that replaces it: one
// action per call, the body always from `--file <path>` or stdin, never a positional
// argument.
//
// Two harnesses, because the seven actions land in two different stores. `--debrief`,
// `--note` and `--remember` write into lib/memory.js's git-ref stores, keyed off
// `process.cwd()` — proved here against a throwaway git repo, read back with the same
// library the CLI calls. `--checkin`, `--tests`, `--risk` and `--left` write into a
// workspace: a local check-in file and a `bd comment`, proved against a fake `bd`
// binary the way test/supersedecli.mjs proves `bin/supersede.js`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-say.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7e-say-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

/* ---------------------------------------------------------- the tracker half */

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2).filter((a, i, all) => a !== '--actor' && all[i - 1] !== '--actor');
const WORLD = path.join(process.env.BEADS_DIR, 'world.json');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
w.calls.push(args.join(' '));
save();
if (args[0] === 'comment') {
  (w.comments[args[1]] = w.comments[args[1]] || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'dep') { process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    { bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] },
    null,
    2
  )
);
const worldFile = path.join(wsDir, 'world.json');
const resetWorld = () => fs.writeFileSync(worldFile, JSON.stringify({ calls: [], comments: {} }, null, 2));
const world = () => JSON.parse(fs.readFileSync(worldFile, 'utf8'));

/* ------------------------------------------------------------ the memory half */

/** A repo with one commit, which is all `workingRepo()` needs — same recipe as test/debrief.mjs. */
function repo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return dir;
}
const repoDir = repo('repo');
// lib/memory.js's `notes`/`recall` resolve their store from `process.cwd()` — same rule
// test/debrief.mjs follows — so the read-back calls below need this process standing
// where the child process wrote, not where `npm test` happened to start it.
process.chdir(repoDir);

/**
 * The command, spawned exactly as a worker would run it — the body on stdin, one
 * non-compound invocation. `cwd` is the repo, which is where `--debrief`/`--note`/
 * `--remember` resolve their store from and where `--checkin`/`--tests`/`--risk`/
 * `--left` merely happen to run — those three read their store from `-w`, not `cwd`.
 */
const say = (args, input = '') => {
  const res = spawnSync(process.execPath, [BIN, '-w', 'demo', ...args], {
    input,
    encoding: 'utf8',
    cwd: repoDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR, BEADCAUSE_AGENT: 'worker' },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

const memory = await import('../lib/memory.js');

let failures = 0;
let ran = 0;
// `fn` may be sync or async — several checks read the memory stores back through
// lib/memory.js's own async API, so this always awaits rather than risking a rejected
// promise nobody caught.
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

console.log('\nagent prose, from a file or stdin, never a shell argument\n');

// The exact shape the bug was: backticks, a command substitution, a newline, and a
// string that looks like a heredoc terminator sitting on its own line in the middle of
// the body. None of it is special to b7e-say — it is just bytes on stdin.
const DANGEROUS = 'Ran `git checkout main -- lib/server.js` and $(rm -rf /tmp/x).\nEOF\nStill more after the terminator.';

/* -------------------------------------------------------------------- --debrief */

await check('--debrief writes a report, byte for byte, readable back through lib/memory.js', async () => {
  const { status, out } = say(['-b', 'bc-say1', '--debrief'], DANGEROUS);
  assert.equal(status, 0, out);
  assert.match(out, /debriefed bc-say1 \(1 this run\)/);
  const staged = await memory.stagedDebrief(repoDir, 'bc-say1');
  assert.equal(staged.entries.length, 1);
  assert.equal(staged.entries[0].text, DANGEROUS, 'the body must round-trip exactly, terminator and all');
  assert.equal(staged.entries[0].agent, 'worker');
});

await check('a second --debrief on the same bead appends rather than replacing', async () => {
  say(['-b', 'bc-say1', '--debrief'], 'a second entry');
  const staged = await memory.stagedDebrief(repoDir, 'bc-say1');
  assert.equal(staged.entries.length, 2, JSON.stringify(staged.entries));
});

/* ------------------------------------------------------------------- --note */

await check('--note writes to this repo\'s notes, byte for byte', async () => {
  const { status, out } = say(['-b', 'bc-say1', '--note', 'a-trap-worth-knowing'], DANGEROUS);
  assert.equal(status, 0, out);
  assert.match(out, /noted worker\.a-trap-worth-knowing/);
  const value = await memory.notes('worker', 'a-trap-worth-knowing');
  assert.equal(value, DANGEROUS);
});

await check('--note with no key is refused before anything is read', () => {
  const { status, err } = say(['-b', 'bc-say1', '--note'], 'text');
  assert.equal(status, 1);
  assert.match(err, /usage: b7e-say .* --note <key>/);
});

await check('a key over 64 characters is refused before anything is written', async () => {
  const longKey = 'x'.repeat(65);
  const { status, err } = say(['-b', 'bc-say1', '--note', longKey], 'text');
  assert.equal(status, 1);
  assert.match(err, /64 max/);
  // The key itself is invalid, so there is no valid call left to read it back with —
  // the proof that nothing landed is that it is absent from the whole listing.
  const all = await memory.notesDetail('worker');
  assert.ok(!(longKey in all), 'nothing was written for the rejected key');
});

/* --------------------------------------------------------------- --remember */

await check('--remember writes to the cross-repo store, byte for byte', async () => {
  const { status, out } = say(['-b', 'bc-say1', '--remember', 'a-lesson-that-travels'], DANGEROUS);
  assert.equal(status, 0, out);
  assert.match(out, /remembered worker\.a-lesson-that-travels/);
  const value = await memory.recall('worker', 'a-lesson-that-travels');
  assert.equal(value, DANGEROUS);
});

/* ---------------------------------------------------------------- --checkin */

await check('--checkin writes the file lib/advocate.js reads back', async () => {
  const { status, out } = say(['-b', 'bc-say1', '--checkin'], 'still working — rebasing onto main');
  assert.equal(status, 0, out);
  assert.match(out, /checked in on demo\/bc-say1/);
  const { checkinFileFor } = await import('../lib/advocate.js');
  const written = JSON.parse(fs.readFileSync(checkinFileFor('demo', 'bc-say1'), 'utf8'));
  assert.equal(written.note, 'still working — rebasing onto main');
  assert.match(written.at, /^20\d\d-/);
});

/* --------------------------------------------------- --tests / --risk / --left */

await check('--tests posts a labelled comment on the bead', () => {
  resetWorld();
  const { status, out } = say(['-b', 'zz-work', '--tests'], DANGEROUS);
  assert.equal(status, 0, out);
  assert.match(out, /commented Tests on zz-work in demo/);
  assert.equal(world().comments['zz-work'][0], `**Tests:** ${DANGEROUS}`);
});

await check('--risk and --left use their own labels, and both land as separate comments', () => {
  resetWorld();
  say(['-b', 'zz-work', '--risk'], 'the migration touches every row');
  say(['-b', 'zz-work', '--left'], 'did not update the android app');
  const comments = world().comments['zz-work'];
  assert.equal(comments[0], '**Worth knowing:** the migration touches every row');
  assert.equal(comments[1], '**Left undone:** did not update the android app');
});

/* --------------------------------------------------------------------- --file */

await check('--file works the same as stdin', async () => {
  const p = path.join(tmp, 'body.txt');
  fs.writeFileSync(p, DANGEROUS);
  const { status } = say(['-b', 'bc-say2', '--debrief', '--file', p]);
  assert.equal(status, 0);
  const staged = await memory.stagedDebrief(repoDir, 'bc-say2');
  assert.equal(staged.entries[0].text, DANGEROUS);
});

/* ------------------------------------------------------------------- refusals */

await check('an empty body is refused, and touches nothing', async () => {
  const { status, err } = say(['-b', 'bc-say3', '--debrief'], '   \n  \n');
  assert.equal(status, 1);
  assert.match(err, /nothing to say/);
  const staged = await memory.stagedDebrief(repoDir, 'bc-say3');
  assert.equal(staged.entries.length, 0);
});

await check('no action at all is refused', () => {
  const { status, err } = say(['-b', 'bc-say1'], 'text');
  assert.equal(status, 1);
  assert.match(err, /pass exactly one action/);
});

await check('two actions at once is refused, and neither runs', async () => {
  const { status, err } = say(['-b', 'bc-say4', '--debrief', '--checkin'], 'text');
  assert.equal(status, 1);
  assert.match(err, /pass exactly one action, not --debrief and --checkin/);
  const staged = await memory.stagedDebrief(repoDir, 'bc-say4');
  assert.equal(staged.entries.length, 0);
});

await check('an unknown workspace is refused and names the ones that exist', () => {
  const res = spawnSync(process.execPath, [BIN, '-w', 'ghost', '-b', 'bc-say1', '--debrief'], {
    input: 'text',
    encoding: 'utf8',
    cwd: repoDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /workspaces: demo/);
});

await check('missing --agent and no BEADCAUSE_AGENT refuses a memory write, and touches nothing', async () => {
  const res = spawnSync(process.execPath, [BIN, '-w', 'demo', '-b', 'bc-say5', '--debrief'], {
    input: 'text',
    encoding: 'utf8',
    cwd: repoDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR, BEADCAUSE_AGENT: '' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no agent/);
  const staged = await memory.stagedDebrief(repoDir, 'bc-say5');
  assert.equal(staged.entries.length, 0);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
