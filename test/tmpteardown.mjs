/**
 * A suite's teardown cannot fail the run, and after `quiesce()` nothing is still writing.
 *
 * The failure this covers (bc-5uy8) is the one that looks least like a failure:
 * `test/dedupe.mjs` printed `26/26 ok` and then exited 1 from its own last line, an
 * ENOTEMPTY rmdir of `<tmp>/config/.git/hooks`. Nothing it asserts was wrong. What was
 * wrong is that `snapshot()` had scheduled a commit into that same directory, `git init`
 * was still laying down `.git/hooks/*.sample`, and `fs.rmSync(tmp, { recursive: true })`
 * walked the tree underneath it. `force: true` is about a path that is *missing*; this is
 * a path that is *more there* than it was a moment ago.
 *
 * Because `scripts/test.mjs` stops at the first non-zero exit, that teardown halted the
 * gate at suite 32 of 105 and the 73 after it never ran — with a green run either side of
 * it. So the property being asserted here is not "the directory goes away". It is:
 *
 * 1. **`quiesce()` really waits.** The control is what makes that worth anything — right
 *    after a snapshot is scheduled the repo is *not* on disk, and after `quiesce()` it is.
 *    An assertion that only looked at the second half would pass against a no-op.
 * 2. **`removeTree()` is never fatal.** A directory it genuinely cannot remove is a
 *    warning and a `false`, not a throw. A teardown that can change a suite's exit code
 *    is the bug, not the mechanism that reports it.
 *
 * Nothing here spawns an agent, touches the network, or writes outside a temp directory.
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tmpteardown-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const CFG = process.env.BEADCAUSE_CONFIG_DIR;

const { cleanupTmp, quiesce, removeTree, removeTreeSync } = await import('./helpers/tmp.mjs');
const { snapshot } = await import('../lib/commonrepo.js');
const { git, ok } = await import('../lib/gitref.js');

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
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/** A throwaway tree with something a few levels down, so the walk has work to do. */
function tree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'leaf'), 'x');
  return root;
}

/* --------------------------------------------------------------- the quiesce */

// First, before anything else can have scheduled a snapshot: the control.
await check('a scheduled snapshot has not yet made the repo — the control for the wait', async () => {
  snapshot('tmpteardown', { delayMs: 0 });
  assert.equal(fs.existsSync(path.join(CFG, '.git')), false, `${CFG}/.git exists already`);
});

await check('quiesce waits for the commit the snapshot scheduled', async () => {
  await quiesce();
  assert.ok(fs.existsSync(path.join(CFG, '.git', 'HEAD')), 'git init did not finish inside quiesce');
  const log = await ok(git(CFG, ['log', '--format=%s']));
  assert.ok(log && log.includes('tmpteardown'), `the reason did not reach the history: ${log}`);
});

await check('after quiesce the repo is quiet — no index.lock, nothing left staged', async () => {
  assert.equal(fs.existsSync(path.join(CFG, '.git', 'index.lock')), false, 'a commit is still running');
  const dirty = await git(CFG, ['status', '--porcelain']);
  assert.equal(dirty.trim(), '', `the working tree is not settled: ${dirty}`);
});

await check('a second flush with nothing pending is not an error', async () => {
  await quiesce();
  await quiesce();
});

/* ------------------------------------------------------------- the removal */

await check('removeTree takes a nested tree away and says so', async () => {
  const root = tree('plain');
  assert.equal(await removeTree(root), true);
  assert.equal(fs.existsSync(root), false);
});

await check('removeTree on a path that is already gone is success, not ENOENT', async () => {
  assert.equal(await removeTree(path.join(tmp, 'never-existed')), true);
});

await check('removeTreeSync does the same, for a teardown that cannot await', async () => {
  const root = tree('sync');
  assert.equal(removeTreeSync(root), true);
  assert.equal(fs.existsSync(root), false);
  assert.equal(removeTreeSync(path.join(tmp, 'never-existed-either')), true);
});

await check('a tree it cannot remove is a warning and a false, never a throw', async () => {
  if (process.getuid?.() === 0) return; // root ignores the mode; there is nothing to prove.
  const root = tree('locked');
  const held = path.join(root, 'a', 'b');
  fs.chmodSync(held, 0o500); // no write bit: the leaf inside cannot be unlinked.
  try {
    // Short budget on purpose — the point is the return value, not the patience.
    assert.equal(await removeTree(root, { retries: 2, delayMs: 1 }), false);
    assert.equal(removeTreeSync(root, { retries: 2, delayMs: 1 }), false);
    assert.ok(fs.existsSync(held), 'the directory should have survived');
  } finally {
    fs.chmodSync(held, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('cleanupTmp is the two of them, in that order', async () => {
  const root = tree('both');
  // Something for the commit to actually be about: `commit()` returns null on an empty
  // index, and a snapshot that had nothing to say would prove nothing about the wait.
  fs.writeFileSync(path.join(CFG, 'state.json'), '{"n":1}');
  snapshot('tmpteardown cleanup', { delayMs: 0 });
  assert.equal(await cleanupTmp(root), true);
  assert.equal(fs.existsSync(root), false);
  // The quiesce ran too: the snapshot above is in the history rather than still pending.
  const log = await ok(git(CFG, ['log', '--format=%s']));
  assert.ok(log && log.includes('cleanup'), `the quiesce did not run: ${log}`);
});

/* -------------------------------------------------------------------- the end */

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
