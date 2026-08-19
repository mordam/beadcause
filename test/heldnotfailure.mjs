/**
 * A window the daemon can see and cannot type into is not a failure — bc-2caji.
 *
 * `resolveFor` has four answers and only one of them is trouble. Three say plainly that
 * somebody is on this pull request: `opened`, `queued`, `reused`. The fourth arrives
 * **wearing an error** — `{ status: 409, held, error }` — and means the same thing: a
 * window exists, on screen, on the branch; what is missing is a handle to nudge it with,
 * because the daemon restarted under it (`restored`) or the iTerm is too old to report a
 * session id. lib/resolvers.js carries `held` out with that error for exactly one reason,
 * and says so where it returns:
 *
 *     "held rides out with it so a caller that is not a thumb can tell this apart from a
 *      failure ... to the sweep one of them is a window doing its job and the other is
 *      trouble, and logging the first as `could not open` is what made bc-9d37.11 hard to
 *      see."
 *
 * `openResolver` in lib/server.js **is** that caller, and until this bead it read the
 * fourth answer as the first kind of trouble. What made that expensive is where the
 * `false` lands: `sweepMergeQueue`'s conflicted path answers a falsy `openResolver` with
 * `record`, which spends an attempt against `MAX_ATTEMPTS`. `BLIND_MS` is thirty minutes
 * and the queue ticks far more often, so **one daemon restart is enough to burn all three
 * attempts**, and `raiseMergeCard` then ejects the bead — taking `merge-queue` off it,
 * which is a one-way handover no sweep undoes. On 2026-08-19 #410, #433 and #438 were
 * ejected precisely that way, each carrying "the branch conflicts with main and nothing
 * could be opened to resolve it" over a window that was on screen the entire time.
 *
 * So there are two claims here and they fail independently:
 *
 *   - **the contract** — a blind record really does come back with `held` *and* `error`,
 *     which is the shape the fix keys on. If lib/resolvers.js ever stops shipping `held`
 *     alongside the error, the guard in lib/server.js silently reverts to the old
 *     behaviour and nothing else in the suite would notice.
 *   - **the classification** — both call sites in lib/server.js exempt `held` from the
 *     error check and count it as handled. Asserted against the source because these are
 *     closures built inside `startServer`, reachable only by standing up a daemon; the
 *     suite already reads that file this way (test/windowbudget.mjs, test/advocateroster.mjs).
 *
 * The site *count* is asserted too, so a third door onto the same registry has to make
 * this decision on purpose rather than inherit the bug by copy-paste.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// As test/resolverqueue.mjs does, and for its reason: CONFIG_DIR resolves once at module
// load, and the running daemon's own config is not this suite's to read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-heldnotfailure-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { resolveFor, remember, reset } = await import(LIB('resolvers.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

const WS = 'beadcause';
const never = () => {
  throw new Error('launch must not be called when a window is already held');
};

/* ------------------------------------------------------------- the contract */

await check('a window with no handle comes back as an error that still carries `held`', async () => {
  remember(WS, 410, { branch: 'worktree-flap', term: null });
  const out = await resolveFor(WS, 410, never, { branch: 'worktree-flap' });

  assert.ok(out.error, 'it is still an error — a thumb is told to go and look');
  assert.equal(out.status, 409);
  // The whole of the fix: the error is qualified, and this is what qualifies it.
  assert.ok(out.held, '`held` rides out with the error, which is what tells a sweep this is not trouble');
  assert.equal(out.held.number, 410);
  assert.equal(out.held.branch, 'worktree-flap');
  // And none of the three plain successes are set, which is why an `opened || queued ||
  // reused` test alone reads this as nothing having happened.
  assert.equal(Boolean(out.opened || out.queued || out.reused), false);
});

await check('a record restored across a daemon restart says why it has no handle', async () => {
  const rec = remember(WS, 433, { branch: 'worktree-space', term: null });
  rec.restored = true;
  const out = await resolveFor(WS, 433, never, { branch: 'worktree-space' });

  assert.ok(out.held, 'still qualified — a restart is the commonest way to get here');
  assert.match(out.error, /restarted since/, out.error);
  assert.match(out.error, /still on your screen/, 'the sentence is about a window that exists');
});

await check('an error with no `held` is the one real failure, and stays one', async () => {
  // The reachable unqualified error: a window with a handle that cannot be reached
  // through it. `held` is deliberately absent there — the record proved unusable rather
  // than merely unaskable — so the guard must still fail this, or nothing ever cards.
  remember(WS, 999, { branch: 'worktree-gone', term: 'iterm-999' });
  const out = await resolveFor(WS, 999, never, {
    branch: 'worktree-gone',
    say: async () => {
      throw new Error('iTerm is not running');
    },
  });

  assert.ok(out.error, out.error);
  assert.equal(out.held, undefined, 'nothing qualifies this one, so `!outcome?.held` lets it through to false');
  assert.equal(Boolean(out.opened || out.queued || out.reused), false);
});

/* --------------------------------------------------------- the classification */

const SERVER = fs.readFileSync(LIB('server.js'), 'utf8');

await check('both doors onto the resolver registry exempt `held` from the error check', async () => {
  const guards = SERVER.match(/if \(outcome\?\.error[^)]*\) return false;/g) || [];
  assert.equal(guards.length, 2, `two doors — openResolver and openAnswer — found ${guards.length}`);
  for (const g of guards) {
    assert.match(g, /!outcome\?\.held/, `a door still fails a held window: ${g}`);
  }
});

await check('and both count a held window as handled', async () => {
  const answers = SERVER.match(/return Boolean\(outcome\?\.opened[^)]*\);/g) || [];
  assert.equal(answers.length, 2, `found ${answers.length} outcome tests`);
  for (const a of answers) {
    assert.match(a, /outcome\?\.held/, `a door does not count a held window as handled: ${a}`);
  }
});

await check('the reason is written down where the next reader of that guard will be', async () => {
  // Not decoration. The guard reads as an oversight without it — `error` plainly means
  // failure — so the bead id is what stops it being "simplified" back.
  assert.match(SERVER, /bc-2caji/, 'the bead that explains the guard is cited at the call site');
});

/* ---------------------------------------------------------------------- out */

console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
