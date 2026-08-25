#!/usr/bin/env node
//
// `b7e-brief` — the standing brief a session gets instead of "read this repo's
// CLAUDE.md", proved against a throwaway fixture repo rather than this repo's own
// 2MB+ README.md and live memory store (both of which change constantly — see
// [[tests]] on "COUNT IT, do not trust this number").
//
//   npm test
//   node test/b7e-brief.mjs
//
// Same recipe as test/b7e-say.mjs: a real git repo with one commit is all
// `lib/memory.js`'s `notes()` needs, and the child process is spawned with `cwd` set to
// it so the memory half resolves the same store this process seeds through the library
// directly. `--dir` on top of that points the README/suite-discovery half at the same
// fixture root, so both halves of the brief read the one throwaway tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-brief');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7e-brief-'));

/** A repo with one commit, which is all `workingRepo()` needs — same recipe as
 * test/debrief.mjs and test/b7e-say.mjs. */
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

// A decoy heading inside a fenced block, a real level-1 and two real level-2 headings,
// and a level-3 heading that must not show up in a "top-level" index — the exact shape
// that trips a naive `grep -n "^# "` (README.md itself has this shape today: a bare `#`
// at the start of a line inside an example config fence reads as a heading to grep and
// is not one).
const FIXTURE_README = [
  '# Fixture',
  '',
  '## First section',
  '',
  'some prose',
  '',
  '```',
  '# not a real heading — inside a fence',
  '```',
  '',
  '## Second section',
  '',
  '### A subsection, not top-level',
  '',
  'more prose',
  '',
].join('\n');
fs.writeFileSync(path.join(repoDir, 'README.md'), FIXTURE_README);
// Present on purpose, to prove the command never reads it even when it exists.
fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'if this text ever appears in the output, something is wrong');
fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
fs.writeFileSync(path.join(repoDir, 'test', 'fixture.mjs'), 'console.log("not a real suite");\n');

// lib/memory.js's `notes`/`note` resolve their store from `process.cwd()` — same rule
// test/debrief.mjs and test/b7e-say.mjs follow — so both the seeding below and the
// read-back after spawning need this process standing where the child writes/reads.
process.chdir(repoDir);
const memory = await import('../lib/memory.js');

await memory.note('worker', 'no-claude-md-readme-is-the-spec', 'FIXTURE spec note — quoted verbatim, not summarised.');
await memory.note('worker', 'worktree-setup', 'FIXTURE worktree note.');
// 'fresh-worktree-fails-pagealias-without-vendor' deliberately left unset — the other
// half of the `worktree` section's key list, to prove a missing key just drops out
// rather than printing an empty quote.
await memory.note('worker', 'the-gate-is-one-command-now-bin-b7e-gate', 'FIXTURE gate note.');
await memory.note('worker', 'sw-cache-bump-rule', 'FIXTURE owed note.');
// Every key under 'owed' but this one is set, and 'swbump-check-scope' is left unset —
// same proof as worktree, in a section with its own header rather than the default one.

const run = (args) => {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: repoDir,
    env: { ...process.env, BEADCAUSE_AGENT: 'worker' },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

let failures = 0;
let ran = 0;
// `fn` may be sync or async — a couple of checks below re-write a memory note through
// lib/memory.js's own async API before reading it back — so this always awaits rather
// than risking a rejected promise nobody caught.
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

console.log('\nb7e-brief — the standing brief instead of a CLAUDE.md that does not exist\n');

/* -------------------------------------------------------------------- the whole brief */

const whole = run(['--dir', repoDir]);

await check('exits 0 and never mentions CLAUDE.md itself', () => {
  assert.equal(whole.status, 0, whole.err);
  assert.doesNotMatch(whole.out, /if this text ever appears/, 'CLAUDE.md was never read');
});

await check('says plainly there is no CLAUDE.md and README.md is the spec', () => {
  assert.match(whole.out, /no CLAUDE\.md/);
  assert.match(whole.out, /README\.md is it/);
});

await check('the README index is derived at run time — real headings, right line numbers, level filtered', () => {
  assert.match(whole.out, /1\s+# Fixture/);
  assert.match(whole.out, /3\s+## First section/);
  assert.match(whole.out, /11\s+## Second section/);
  // The heading inside the fence must never appear as an index entry.
  assert.doesNotMatch(whole.out, /not a real heading/);
  // Level 3 is not "top-level" — excluded from the index.
  assert.doesNotMatch(whole.out, /A subsection, not top-level/);
});

await check('a retitled heading shows up with no edit to the tool — same fixture, new title', () => {
  fs.writeFileSync(path.join(repoDir, 'README.md'), FIXTURE_README.replace('Second section', 'Retitled section'));
  const after = run(['--dir', repoDir, '--section', 'spec']);
  assert.match(after.out, /## Retitled section/);
  assert.doesNotMatch(after.out, /## Second section/);
  fs.writeFileSync(path.join(repoDir, 'README.md'), FIXTURE_README); // restore for later checks
});

await check('house facts are quoted verbatim, not summarised', () => {
  assert.match(whole.out, /FIXTURE spec note — quoted verbatim, not summarised\./);
  assert.match(whole.out, /FIXTURE worktree note\./);
  assert.match(whole.out, /FIXTURE gate note\./);
  assert.match(whole.out, /FIXTURE owed note\./);
});

await check('a note changes the output on the next call with no edit here', async () => {
  await memory.note('worker', 'sw-cache-bump-rule', 'FIXTURE owed note, corrected.');
  const after = run(['--dir', repoDir, '--section', 'owed']);
  assert.match(after.out, /FIXTURE owed note, corrected\./);
  assert.doesNotMatch(after.out, /FIXTURE owed note\.\n/);
});

await check('a key with no note dropped from the store never prints an empty quote', () => {
  // 'fresh-worktree-fails-pagealias-without-vendor' and 'swbump-check-scope' were never
  // set — their bracketed key name must not appear at all, empty or otherwise.
  assert.doesNotMatch(whole.out, /\[fresh-worktree-fails-pagealias-without-vendor\]/);
  assert.doesNotMatch(whole.out, /\[swbump-check-scope\]/);
});

await check('all four sections are present with no errors, in one call', () => {
  assert.match(whole.out, /There is no CLAUDE\.md here/);
  assert.match(whole.out, /A fresh worktree, before anything else/);
  assert.match(whole.out, /How the suite is actually run here/);
  assert.match(whole.out, /What a change under public\/ owes/);
});

await check('counts suites live rather than repeating a stale number', () => {
  assert.match(whole.out, /finds 1 suites here right now/);
});

/* --------------------------------------------------------------------------- --section */

await check('--section prints exactly one part', () => {
  const spec = run(['--dir', repoDir, '--section', 'spec']);
  assert.equal(spec.status, 0, spec.err);
  assert.match(spec.out, /There is no CLAUDE\.md here/);
  assert.doesNotMatch(spec.out, /A fresh worktree, before anything else/);
  assert.doesNotMatch(spec.out, /How the suite is actually run here/);
  assert.doesNotMatch(spec.out, /What a change under public\/ owes/);
});

await check('--section worktree with one of its two keys unset still prints the one that is set', () => {
  const worktree = run(['--dir', repoDir, '--section', 'worktree']);
  assert.match(worktree.out, /FIXTURE worktree note\./);
  assert.doesNotMatch(worktree.out, /\[fresh-worktree-fails-pagealias-without-vendor\]/);
});

await check('an unrecognised --section value is refused before anything runs', () => {
  const bad = run(['--dir', repoDir, '--section', 'nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.err, /--section must be one of: spec, worktree, gate, owed/);
});

/* ----------------------------------------------------------------------------- --help */

await check('--help prints usage and exits 0 without touching the memory store', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /b7e-brief --section <name>/);
});

/* --------------------------------------------------------------------- a bare fixture */

await check('a fixture with no test/ directory at all still runs clean — no crash, zero suites', () => {
  const bareDir = repo('bare');
  fs.writeFileSync(path.join(bareDir, 'README.md'), '# Bare\n\n## Only section\n');
  const res = run(['--dir', bareDir]);
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /finds 0 suites here right now/);
  assert.match(res.out, /Only section/);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
