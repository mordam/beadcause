/**
 * `commitToRef`'s own recovery from a stale lock — bc-xl7n.93.
 *
 * bc-xl7n.79 fixed this once already, for the config repo's `HEAD` inside
 * lib/commonrepo.js's `commit()`. bc-xl7n.93 is the identical failure one door along:
 * `commitToRef` (this file) writes arbitrary refs — `refs/beadcause/memory`,
 * `refs/beadcause/bus/<topic>`, a session's own log — through `update-ref`, and a `git`
 * that dies mid-write leaves a `*.lock` file under `refs/beadcause/<topic>` with no
 * owner. Every subsequent write to that one topic then fails identically forever, and
 * every `cas()` retry loop above it (lib/memory.js) reads the failure as "somebody
 * else's write landed first" and spins uselessly against a race that was never real —
 * see the module note at the top of lib/gitref.js.
 *
 * The fix reuses exactly the shape lib/commonrepo.js proved out (age + `lsof`, both
 * have to say abandoned), so this suite mirrors test/commonrepo.mjs's "the lock nobody
 * is holding" section rather than re-deriving it, checked here against `commitToRef`
 * on an ordinary ref instead of `commit()` on `HEAD`. The one addition is the last
 * check: a genuine compare-and-swap loss must still fail, because it leaves no lock
 * file on disk for the recovery to find and clear.
 *
 * A plain `git init` in a scratch directory — no `BEADCAUSE_CONFIG_DIR`, no
 * lib/commonrepo.js involved at all, so this is a test of lib/gitref.js alone.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-gitref-'));
const DIR = path.join(tmp, 'repo');
fs.mkdirSync(DIR, { recursive: true });
execFileSync('git', ['init', '-q', DIR]);

const { commitToRef, writeTree, refTip } = await import(LIB('gitref.js'));

const REF = 'refs/beadcause/memory';
const LOCK = path.join(DIR, '.git', 'refs', 'beadcause', 'memory.lock');
const AGES_AGO = new Date(Date.now() - 60 * 60 * 1000);

/** A one-file tree, distinct each call so every commit is a real write. */
const tree = (n) => writeTree(DIR, [['file.json', Buffer.from(`${JSON.stringify({ n })}\n`)]]);

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

console.log('commitToRef and the lock nobody is holding');

await check('an ordinary write lands with no lock in the way', async () => {
  const { commit } = await commitToRef(DIR, REF, await tree(1), 'first');
  assert.ok(commit, 'a commit sha has to come back');
  assert.equal(await refTip(DIR, REF), commit, 'and the ref has to point at it');
});

await check('a lock a live process holds is left alone, and the write is dropped', async () => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, '');
  fs.utimesSync(LOCK, AGES_AGO, AGES_AGO);
  // Old enough by any measure — the only thing standing between it and removal is that
  // this test process has it open, exactly the state a real `git commit` is in.
  const fd = fs.openSync(LOCK, 'r');
  try {
    const t = await tree(2);
    await assert.rejects(
      () => commitToRef(DIR, REF, t, 'second'),
      /lock/i,
      'a held lock has to still fail the write'
    );
    assert.ok(fs.existsSync(LOCK), 'and must not be removed out from under whoever is holding it');
  } finally {
    fs.closeSync(fd);
  }
});

await check('a lock made moments ago is left alone too — the ordinary race', async () => {
  const now = new Date();
  fs.utimesSync(LOCK, now, now);
  const t = await tree(2);
  await assert.rejects(
    () => commitToRef(DIR, REF, t, 'second'),
    /lock/i,
    'a fresh lock is another writer, and losing to it is the design'
  );
  assert.ok(fs.existsSync(LOCK), 'so it stays, and the next write picks up both changes');
});

await check('but an abandoned one is removed and the write lands', async () => {
  // The ref-write half of bc-xl7n.79: a lock with no holder, sitting there since a git
  // that died, failing every write to this one topic identically until now.
  fs.utimesSync(LOCK, AGES_AGO, AGES_AGO);
  const { commit } = await commitToRef(DIR, REF, await tree(2), 'second');
  assert.ok(commit, 'the retry after clearing has to actually land');
  assert.equal(fs.existsSync(LOCK), false, 'and the dead lock has to be gone');
  assert.equal(await refTip(DIR, REF), commit, 'and the ref has to point at the new commit');
});

await check('a genuine compare-and-swap loss is untouched by any of this', async () => {
  // Someone else's write landed first: `expect` names a parent the ref no longer has.
  // Nothing here should paper over a real lost race — that failure has to keep reaching
  // the caller's own retry (lib/memory.js's `cas()`), which re-reads the tip and
  // re-merges, rather than being silently swallowed as if it were a stale lock.
  const staleParent = await refTip(DIR, REF);
  await commitToRef(DIR, REF, await tree(3), 'third'); // moves the ref past staleParent
  const t = await tree(4);
  await assert.rejects(
    () => commitToRef(DIR, REF, t, 'fourth', { expect: staleParent }),
    /cannot lock ref/i,
    'a stale expect has to still fail'
  );
  assert.equal(fs.existsSync(LOCK), false, 'and it must not have invented a lock file to clear');
});

console.log(`\n${ran - failures}/${ran} passed`);
if (failures) process.exitCode = 1;

await cleanupTmp(tmp);
