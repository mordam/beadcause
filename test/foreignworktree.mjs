#!/usr/bin/env node
/**
 * `~/.claude/hooks/worktree-guard.sh` — the half of it that asks *whose* worktree this is.
 *
 *     npm test
 *     node test/foreignworktree.mjs
 *
 * bc-tstol. The guard has always denied Edit/Write in a repo's **main checkout**, and the
 * rule it exists to serve is "your own worktree, claimed by you". Those are not the same
 * sentence, and on 2026-08-30 the gap between them cost a branch: a handoff opened its
 * successor inside a **still-live** predecessor's locked worktree, the successor got no
 * denial — it was not in the main checkout — and a SessionStart line that affirmatively
 * said `← you`, because that mark was chosen by directory alone. Two sessions then put
 * commits on one branch out of one index, over another session's uncommitted edits.
 *
 * So the guard now compares the worktree's lock pid to the editing process's **ancestry**,
 * and this suite pins all four answers to that question, because three of them must NOT
 * deny and only one must:
 *
 * | lock                          | verdict | why                                        |
 * |-------------------------------|---------|--------------------------------------------|
 * | live pid, not an ancestor     | DENY    | a sibling session is working in there       |
 * | live pid, is an ancestor      | allow   | it is our own claim — the normal case       |
 * | pid that is gone (stale)      | allow   | prunable, inheritable, must stay editable   |
 * | no lock / no pid in the lock  | allow   | cannot tell, and cannot tell is permissive  |
 *
 * The stale row is the one worth being loud about: a guard that denied there would brick
 * every worktree whose session has exited, which is most of the 70-odd in this repo at any
 * moment. The over-strict direction is not the safe direction here.
 *
 * The ancestry test is the part that is easy to get wrong. The lock names the **claude**
 * process; the hook runs several levels below it (claude → zsh → hook), so `$$ == pid` is
 * never true and a guard written that way denies every session its own worktree. What the
 * fixtures below exploit is that a process this test *spawns* is a sibling of the hook, not
 * an ancestor — so a real live pid that is genuinely foreign is one `sleep` away.
 *
 * Real `bash`, a real temp git repo with a real `git worktree`, real pids. The hook lives
 * outside every checkout (it is `~/.claude/hooks/…`), so the whole suite skips when it is
 * not installed — this has to pass on a machine that has never set the workflow up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cleanupTmp } from './helpers/tmp.mjs';

const GUARD = path.join(os.homedir(), '.claude', 'hooks', 'worktree-guard.sh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-foreignwt-')));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

if (!fs.existsSync(GUARD)) {
  console.log(`  (${GUARD} is not installed — nothing to check)\n\n0 passed\n`);
  await cleanupTmp(tmp);
  process.exit(0);
}

/* ---------------------------------------------------------------- fixtures */

/**
 * A repo that opts into the workflow (`.claude/worktrees/` exists) with one worktree in
 * it. Returns both roots plus the worktree's git dir, which is where `locked` lives — the
 * lock is not in the worktree, which is half of why a session inside one cannot see it.
 */
function repoWithWorktree(name) {
  const main = path.join(tmp, name);
  fs.mkdirSync(path.join(main, '.claude', 'worktrees'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(main, 'README.md'), 'hi\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  const wt = path.join(main, '.claude', 'worktrees', 'wt');
  git('worktree', 'add', '-q', '-b', 'worktree-wt', wt);
  return { main, wt, lock: path.join(main, '.git', 'worktrees', 'wt', 'locked') };
}

/** The lock text EnterWorktree writes, which is the only shape carrying a pid. */
const lockText = (pid) => `claude session wt (pid ${pid} start Sat Aug 29 21:18:39 2026)\n`;

/** Ask the guard about an Edit of `file`. Returns the deny reason, or '' for a pass. */
function guard(file, cwd = tmp) {
  const r = spawnSync('bash', [GUARD, 'guard'], {
    input: JSON.stringify({ tool_input: { file_path: file } }),
    encoding: 'utf8',
    timeout: 30000,
    cwd,
  });
  assert.equal(r.status, 0, `the hook must always exit 0: ${r.stderr}`);
  if (!r.stdout.trim()) return '';
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

/** The SessionStart banner, as seen from `cwd`. */
function report(cwd) {
  const r = spawnSync('bash', [GUARD, 'report'], { encoding: 'utf8', timeout: 30000, cwd });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).systemMessage : '';
}

// A live pid that is genuinely not ours: spawned here, so it is the hook's *sibling*.
const sibling = spawn('sleep', ['120'], { stdio: 'ignore' });
// And a pid that is certainly gone: the same trick, awaited.
const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();

/* ------------------------------------------------------- guard: the four answers */

console.log('worktree-guard.sh guard — whose worktree is this');

check('DENIES a worktree locked by another LIVE session, and names the pid', () => {
  const { wt, lock } = repoWithWorktree('foreign');
  fs.writeFileSync(lock, lockText(sibling.pid));
  const why = guard(path.join(wt, 'lib', 'server.js'));
  assert.ok(why, 'the edit was allowed — this is the bc-tstol failure exactly');
  assert.match(why, new RegExp(`\\b${sibling.pid}\\b`), `the pid is the actionable fact: ${why}`);
  assert.match(why, /ANOTHER LIVE SESSION/, why);
  assert.match(why, /EnterWorktree/, 'and the denial has to say what to do instead');
  // The point of naming the lock text is that it identifies *which* session, by the name
  // it gave itself — a bare pid is not enough to go and look at the right window.
  assert.match(why, /claude session wt/, why);
});

check('does NOT deny the session that owns the lock', () => {
  const { wt, lock } = repoWithWorktree('mine');
  // `process.pid` is this test; the hook it spawns is a descendant, so the lock is "ours"
  // in exactly the way a real claude session's is. A guard comparing `$$` fails here.
  fs.writeFileSync(lock, lockText(process.pid));
  assert.equal(guard(path.join(wt, 'lib', 'server.js')), '', 'denied a session its own worktree');
});

check('does NOT deny on a stale lock — that is the prunable case', () => {
  const { wt, lock } = repoWithWorktree('stale');
  fs.writeFileSync(lock, lockText(dead));
  assert.equal(guard(path.join(wt, 'lib', 'server.js')), '', `pid ${dead} is gone; the worktree is inheritable`);
});

check('does NOT deny a lock with no pid in it, or no lock at all', () => {
  const { wt, lock } = repoWithWorktree('unreadable');
  assert.equal(guard(path.join(wt, 'lib', 'server.js')), '', 'an unlocked worktree is nobody’s business');
  // The older lock format, still on disk in this repo, says only who and not which pid.
  fs.writeFileSync(lock, 'claude session 0019614b\n');
  assert.equal(guard(path.join(wt, 'lib', 'server.js')), '', 'cannot tell must not mean deny');
});

check('a Write to a file that does not exist yet is judged the same way', () => {
  // Write targets need not exist, and the deepest-existing-ancestor walk is what makes the
  // guard see a repo at all. A new file in a sibling's worktree is the common shape.
  const { wt, lock } = repoWithWorktree('newfile');
  fs.writeFileSync(lock, lockText(sibling.pid));
  assert.match(guard(path.join(wt, 'src', 'nested', 'brand-new.js')), /ANOTHER LIVE SESSION/);
});

check('the main-checkout deny is untouched, allowlist included', () => {
  const { main, lock } = repoWithWorktree('mainstill');
  fs.writeFileSync(lock, lockText(sibling.pid));
  assert.match(guard(path.join(main, 'lib', 'server.js')), /MAIN CHECKOUT/);
  assert.equal(guard(path.join(main, 'CLAUDE.md')), '', 'CLAUDE.md is editable in the main checkout');
  assert.equal(guard(path.join(main, '.claude', 'handoff.md')), '', '.claude/** is where handoffs go');
});

check('a repo that has not opted in is left alone entirely', () => {
  const { main, wt, lock } = repoWithWorktree('optout');
  fs.rmSync(path.join(main, '.claude', 'worktrees'), { recursive: true });
  fs.writeFileSync(lock, lockText(sibling.pid));
  assert.equal(guard(path.join(wt, 'lib', 'server.js')), '', 'no .claude/worktrees → not our workflow');
  assert.equal(guard(path.join(main, 'lib', 'server.js')), '');
});

/* ------------------------------------------------- report: the line that misinformed */

console.log('worktree-guard.sh report — the “← you” that was a lie');

check('withholds “← you” from a worktree another live session holds', () => {
  const { wt, lock } = repoWithWorktree('banner');
  fs.writeFileSync(lock, lockText(sibling.pid));
  const msg = report(wt);
  assert.ok(!/← you\b/.test(msg), `this is the sentence that told 37283 the worktree was its own:\n${msg}`);
  assert.match(msg, /LOCKED BY ANOTHER LIVE SESSION/, msg);
  assert.match(msg, new RegExp(`\\b${sibling.pid}\\b`), msg);
  assert.match(msg, /EnterWorktree/, 'the banner is read before the first edit — it must say the fix');
});

check('still says “← you” about a worktree that is actually yours', () => {
  const { wt, lock } = repoWithWorktree('banner-mine');
  fs.writeFileSync(lock, lockText(process.pid));
  const msg = report(wt);
  assert.match(msg, /← you\b/, msg);
  assert.ok(!/ANOTHER LIVE SESSION/.test(msg), msg);
});

check('a stale lock is reported prunable, not stolen', () => {
  const { wt, lock } = repoWithWorktree('banner-stale');
  fs.writeFileSync(lock, lockText(dead));
  const msg = report(wt);
  assert.match(msg, /← you\b/, 'an abandoned worktree you are standing in is yours to use');
  assert.match(msg, /STALE pid/, msg);
});

/* ------------------------------------------------------------------------ done */

sibling.kill();
await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
