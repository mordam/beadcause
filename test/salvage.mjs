#!/usr/bin/env node
//
// What a dead window left behind, told to the bead it was working — bc-xl7n.102.
//
//   npm test                     (runs it alongside the rest)
//   node test/salvage.mjs
//
// A worker window that commits and then dies leaves the bead **correct and the evidence
// invisible**. `reconcile` hands the claim back — which is right, and is bc-xl7n.85 — and
// the archive counts the commits, logs the count, and drops them: `pendingNotes` has one
// consumer and it writes its git note *when the branch reaches main*, which for a bead
// that has gone back into the queue is never. So the next window opens a fresh worktree
// and rebuilds work that already exists and already passes. Measured twice on bc-xl7n.37,
// whose 247-line passing suite was rescued both times by an advocate typing a comment by
// hand.
//
// Two halves, tested separately because they fail separately:
//
// 1. **`salvageNote`** builds the sentence, against a real repo — the branch, the head
//    sha, the subjects and the count, plus the two facts that change what the reader
//    should *do*: how far behind main it is, and whether the branch was ever pushed. A
//    branch with no commits, or one already in main, has nothing to say and says nothing.
// 2. **`lib/advocate.js` asks for it on exactly one ending.** The wiring is read as source
//    rather than driven, because driving it means a real `archiveSession` over a real
//    transcript directory; what can go wrong here is the *gate* — a comment on a delivered
//    bead, or on a window that built nothing — and the gate is four conditions in one line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-salvage-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { salvageNote } = await import(path.join(ROOT, 'lib', 'sessionlog.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* --------------------------------------------------------------- the fixture repo */

const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });

const git = (args, cwd = repo) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'beadcause-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'beadcause-test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });

const write = (name, body) => {
  fs.writeFileSync(path.join(repo, name), body);
  git(['add', '-A']);
  git(['commit', '-qm', body.trim()]);
  return git(['rev-parse', 'HEAD']).trim();
};

git(['init', '-q', '-b', 'main']);
write('file.txt', 'one\n');

// The dead window's branch: two commits, never pushed.
git(['checkout', '-q', '-b', 'worktree-cover-x1']);
write('suite.mjs', 'x-1: add the suite\n');
write('helper.mjs', 'x-1: fix the helper\n');
const deadHead = git(['rev-parse', 'HEAD']).trim();
const deadCommits = git(['rev-list', 'worktree-cover-x1', '--not', 'main']).trim().split('\n');

// And main moving on underneath it, so "behind main" is a real number rather than zero.
git(['checkout', '-q', 'main']);
write('other.txt', 'somebody else landed this\n');

// A branch that *did* reach main, for the case that must stay silent.
git(['checkout', '-q', '-b', 'worktree-landed-x2']);
const landedHead = write('landed.txt', 'x-2: landed\n');
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', '-m', 'merge x-2', 'worktree-landed-x2']);

/* ------------------------------------------------------------------ the sentence */

await check('it names the branch, the head sha, the count and every subject', async () => {
  const said = await salvageNote(repo, {
    bead: 'x-1',
    ref: 'refs/beadcause/sessions/x-1',
    branch: 'worktree-cover-x1',
    head: deadHead,
    commits: deadCommits,
  });

  assert.ok(said, 'there is something to say');
  assert.match(said, /worktree-cover-x1/, 'the branch, which is the only way back to the work');
  assert.ok(said.includes(deadHead), 'the head sha, in full — an abbreviation is not a handle');
  assert.match(said, /commits {2}2\b/, 'the count');
  assert.match(said, /x-1: add the suite/, 'the first subject');
  assert.match(said, /x-1: fix the helper/, 'the second subject');
  assert.match(said, /refs\/beadcause\/sessions\/x-1/, 'and where the session log went');
});

await check('it gives the worktree an address, not just a branch name', async () => {
  // "Look at that branch" is not actionable on its own — the work is already checked out
  // somewhere, and `archiveSession` had to resolve where in order to read the commits at
  // all. A session whose worktree could not be resolved says nothing rather than guessing.
  const said = await salvageNote(repo, {
    bead: 'x-1',
    branch: 'worktree-cover-x1',
    head: deadHead,
    worktree: '/somewhere/.claude/worktrees/cover-x1',
    commits: deadCommits,
  });
  assert.match(said, /\/somewhere\/\.claude\/worktrees\/cover-x1/, 'the directory is named');

  const unresolved = await salvageNote(repo, {
    bead: 'x-1',
    branch: 'worktree-cover-x1',
    head: deadHead,
    commits: deadCommits,
  });
  assert.doesNotMatch(unresolved, /^ {4}worktree /m, 'and an unresolved one leaves the line out');
});

await check('it says how far behind main the branch is', async () => {
  const said = await salvageNote(repo, {
    bead: 'x-1',
    branch: 'worktree-cover-x1',
    head: deadHead,
    commits: deadCommits,
  });

  // Three commits reached main after the branch left it: the one this suite wrote directly,
  // the second branch's commit, and the merge that brought it in. What matters is that the
  // number is *there* and is not zero — a reader deciding between a checkout and a
  // cherry-pick cannot get it from a sha.
  assert.match(said, /behind main/, 'the drift is stated');
  const [, behind] = said.match(/(\d+) behind main/) || [];
  assert.equal(behind, '3', 'and it is counted rather than guessed');
});

await check('an unpushed branch is called the only copy', async () => {
  const said = await salvageNote(repo, {
    bead: 'x-1',
    branch: 'worktree-cover-x1',
    head: deadHead,
    commits: deadCommits,
  });

  assert.match(said, /never pushed/, 'because it is, and the worktree is all there is');
  assert.doesNotMatch(said, /pull request/, 'and there cannot be one');
});

await check('a pushed branch is not called lost', async () => {
  // The same branch, with a remote-tracking ref planted for it — which is what a delivery
  // leaves behind. bc-xl7n.83 is this shape: handed back on a timeout with its work sitting
  // in an open pull request, where "never pushed" would simply be false.
  git(['update-ref', 'refs/remotes/origin/worktree-cover-x1', deadHead]);
  try {
    const said = await salvageNote(repo, {
      bead: 'x-1',
      branch: 'worktree-cover-x1',
      head: deadHead,
      commits: deadCommits,
    });
    assert.doesNotMatch(said, /never pushed/, 'it is on origin');
    assert.match(said, /pull request/, 'and the next window should look for what carries it');
  } finally {
    git(['update-ref', '-d', 'refs/remotes/origin/worktree-cover-x1']);
  }
});

/* -------------------------------------------------------------- and when to say nothing */

await check('a window that built nothing leaves nothing', async () => {
  const said = await salvageNote(repo, { bead: 'x-1', branch: 'worktree-cover-x1', head: deadHead, commits: [] });
  assert.equal(said, null, 'no commits, no comment — that is the honest answer');
});

await check('a session with no branch leaves nothing', async () => {
  const said = await salvageNote(repo, { bead: 'x-1', branch: null, head: null, commits: [] });
  assert.equal(said, null);
});

await check('work already in main is not offered back', async () => {
  // The caller gates on `!res.merged`, and `sessionCommits` returns nothing for a merged
  // branch anyway — so this arrives empty and must stay silent rather than describe a
  // branch whose commits are already where the next window would be working.
  const merged = git(['rev-list', 'worktree-landed-x2', '--not', 'main']).trim();
  assert.equal(merged, '', 'the fixture really did land it');
  const said = await salvageNote(repo, {
    bead: 'x-2',
    branch: 'worktree-landed-x2',
    head: landedHead,
    commits: [],
  });
  assert.equal(said, null);
});

/* ------------------------------------------------------------------ and the gate */

const advocate = fs.readFileSync(path.join(ROOT, 'lib', 'advocate.js'), 'utf8');

await check('the hand-back is what marks a worker for it', async () => {
  assert.match(advocate, /w\.handedBack = true;/, 'set in `handBack`');
  // After the tracker write, not before it: a hand-back bd refused leaves the bead claimed,
  // and nothing is about to open a window on a claimed bead.
  const flag = advocate.indexOf('w.handedBack = true;');
  const refused = advocate.indexOf('could not hand ${w.id} back to the queue');
  assert.ok(refused > -1 && flag > refused, 'and only once the claim is actually off');
});

await check('the comment is asked for on exactly the ending nobody chose', async () => {
  const line = advocate.split('\n').find((l) => l.includes('worker.handedBack && res.head'));
  assert.ok(line, 'the gate exists');
  assert.match(line, /!res\.merged/, 'nothing to salvage from work already in main');
  assert.match(line, /res\.commits\.length/, 'and nothing to salvage from a window that built nothing');
});

await check('a tracker that refuses the comment does not cost the archive', async () => {
  // The whole point of the ordering in `archiveFinished`: the archive is the record, the
  // comment is a courtesy, and one bead's tracker failing must not end the finished list.
  const at = advocate.indexOf('worker.handedBack && res.head');
  const after = advocate.slice(at, at + 1600);
  assert.match(after, /try \{/, 'the write is guarded');
  assert.match(after, /could not tell \$\{worker\.id\} what its dead window built/, 'and says so rather than throwing');
});

/* ------------------------------------------------------------------------- end */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
