#!/usr/bin/env node
/**
 * lib/bd.js — the ceiling every `bd` invocation runs under, and what a slow one is called.
 *
 *     npm test
 *     node test/bdtimeout.mjs
 *
 * Two failures, and the second is the one that made the first invisible for a month.
 *
 * 1. **A ceiling this laptop clears on an ordinary afternoon.** `run` defaulted to thirty
 *    seconds, and `bd list --all` over 503 beads — a second idle — took **28.6s** here
 *    under a load average of 33: twenty agent sessions and a full `npm test`, which is a
 *    Tuesday and not a pathological case. Everything downstream reads a killed child as a
 *    dead workspace, so the failure mode of a busy machine was every repo drawing as
 *    broken while `bd` was merely slow, once per poll, for as long as the load lasted.
 *    `listAll` was given a ceiling of its own when that was measured (bc-nib3.1) and that
 *    fixed one call site out of seven — which is the shape of bug this file guards. The
 *    number lives in one place now, and what is asserted is that it is generous and that
 *    nothing narrows it: a read added next month inherits it by doing nothing at all.
 * 2. **A timeout that reads as a failure.** It is the one error here that arrives with
 *    nothing to explain itself — `execFile` SIGTERMs `bd` mid-answer, so stderr is empty
 *    and the message is Node's own "Command failed". Undecorated it goes to the phone,
 *    to `trouble` and to `errors[]` looking exactly like a tracker that has fallen over.
 *    So it says it timed out, in those words, wherever a message is displayed, and it
 *    carries `timedOut` for anything that would rather branch than read English.
 *
 * The behavioural half runs a real `execFile` against a real fake `bd` — a script that
 * hangs, one that fails, one that reports a lock, one that floods the pipe. Nothing here
 * touches a tracker, the network or a bead. The ceilings under test are milliseconds:
 * the point is never how long two minutes is, it is what happens at the end of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bd.js'), 'utf8');

const { Bd, BD_TIMEOUT } = await import(path.join(ROOT, 'lib', 'bd.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-bdtimeout-'));
const WS = { name: 'beadcause', dir: tmp };

/** A `bd` that does one thing and does it every time. */
const fakeBd = (name, body) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
};

/** Hangs until it is killed. A timer rather than a spin, so it costs no CPU. */
const HANGS = fakeBd('bd-hangs', `setTimeout(() => process.exit(0), 60_000);`);
/** Fails the way bd fails: a sentence on stderr and a non-zero exit. */
const FAILS = fakeBd('bd-fails', `process.stderr.write('bd: no such issue bc-nope'); process.exit(1);`);
/** Loses the Dolt lock — the one failure that is worth asking again about. */
const LOCKED = fakeBd(
  'bd-locked',
  `const fs = require('node:fs');
   const tally = ${JSON.stringify(path.join(tmp, 'lock-calls'))};
   fs.appendFileSync(tally, 'x');
   process.stderr.write('dolt: database is locked by another process');
   process.exit(1);`
);
/** Writes past `run`'s 32MB maxBuffer, which also kills the child — and is not a timeout. */
// No `process.exit` after the write: exiting truncates a pipe that has not drained, and
// a fake that only ever sent 8MB would pass this by never blowing the buffer at all.
const FLOODS = fakeBd('bd-floods', `process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 120));`);

const bdOf = (bin) => new Bd({ bin, actor: 'beadcause-test' });
const caught = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
};

/* ============================================================ the ceiling, and its reason */

console.log('\nthe ceiling every call runs under');

check(
  'the number is written down once, in an exported constant, not typed at a call site',
  typeof BD_TIMEOUT === 'number' && /export const BD_TIMEOUT = /.test(SRC),
  String(BD_TIMEOUT)
);

check(
  'and it clears the 28.6s a loaded Mac took to answer, with room the load can grow into',
  BD_TIMEOUT >= 60_000,
  `BD_TIMEOUT is ${BD_TIMEOUT}`
);

check(
  '`run` takes it as its default, so a call that says nothing about time gets all of it',
  /run\(workspace, rawArgs, \{ retries = 0, timeout = BD_TIMEOUT/.test(SRC),
  SRC.split('\n').find((l) => l.includes('run(workspace, rawArgs')) || 'no run() signature found'
);

// The whole bug was one call site fixed and six left behind. A literal `timeout:` in this
// file is either a second copy of the decision or a quiet cut below it, and both are how
// it comes back.
const literals = [...SRC.matchAll(/timeout:\s*([0-9_]+)/g)].map((m) => Number(m[1].replace(/_/g, '')));
check(
  'no method narrows it behind the constant with a number of its own',
  literals.every((n) => n >= BD_TIMEOUT),
  `hard-coded timeouts in lib/bd.js: ${literals.join(', ') || '(none)'}`
);

/* ---- and the same, asked of the methods rather than of the text ---- */

console.log('\nevery read on the sweep path, asked what ceiling it goes out with');

// The six that run on a timer, across every workspace, plus the one that was already
// fixed. `run` is replaced rather than the binary faked: what is under test is the
// options each method chooses, and a method that passes nothing is passing the default.
const spied = () => {
  const bd = bdOf('/nonexistent/bd');
  bd.opts = [];
  bd.run = async (workspace, args, opts = {}) => {
    bd.opts.push(opts);
    return '[]';
  };
  return bd;
};

const READS = [
  ['listHuman', (bd) => bd.listHuman(WS)],
  ['listAgent', (bd) => bd.listAgent(WS)],
  ['listStatus', (bd) => bd.listStatus(WS, 'open')],
  ['listLabel', (bd) => bd.listLabel(WS, 'human')],
  ['listAll', (bd) => bd.listAll(WS)],
  ['children', (bd) => bd.children(WS, 'bc-goo')],
  ['status', (bd) => bd.status(WS)],
  ['ready', (bd) => bd.ready(WS)],
  ['graphHtml', (bd) => bd.graphHtml(WS, null)],
];

for (const [name, call] of READS) {
  const bd = spied();
  await call(bd);
  const asked = bd.opts.map((o) => o.timeout ?? BD_TIMEOUT);
  check(
    `${name} runs under at least ${Math.round(BD_TIMEOUT / 1000)}s`,
    asked.length > 0 && asked.every((t) => t >= BD_TIMEOUT),
    `asked for ${asked.join(', ') || '(no call made)'}`
  );
}

/* ============================================================ what a slow call is called */

console.log('\na call that was killed for being slow, against one that failed');

const slow = await caught(bdOf(HANGS).run(WS, ['list', '--all'], { timeout: 300 }));

check('it rejects rather than hanging forever', slow instanceof Error, String(slow));
check('and says it timed out, in the message anything downstream displays', /timed out/i.test(slow?.message || ''), slow?.message);
check(
  'with the ceiling it hit, so the number on screen is the one to argue with',
  /still running after \d+m?s/.test(slow?.message || ''),
  slow?.message
);
check('and the workspace, because a sweep runs against five of them', /in beadcause:/.test(slow?.message || ''), slow?.message);
check(
  'it does not claim bd failed — it was still running when we killed it',
  !/ failed in /.test(slow?.message || ''),
  slow?.message
);
check('and it is flagged, for a caller that would rather branch than read English', slow?.timedOut === true, String(slow?.timedOut));

const failed = await caught(bdOf(FAILS).run(WS, ['show', 'bc-nope']));
check('a real failure still reads as one', / failed in beadcause: /.test(failed?.message || ''), failed?.message);
check('and still carries what bd said about it', /no such issue bc-nope/.test(failed?.message || ''), failed?.message);
check('and is not flagged as a timeout', failed?.timedOut === false, String(failed?.timedOut));

// The sweep is the screen this is for, and it is four inches wide: it keeps the sentence
// after the colon and drops the argv and the repo name, both of which the row already
// carries. A message shaped any other way arrives there as a wall of flags.
const { createSweep } = await import(path.join(ROOT, 'lib', 'sweep.js'));
const sweep = createSweep('questions');
sweep.failed('beadcause', slow);
const shown = sweep.trouble()[0]?.error || '';
check('and on the phone it is the sentence, not the argv', /^still running after/.test(shown), shown);
check('which still says it was slow rather than broken', /killed rather than broken/.test(shown), shown);

/* ---- the retry belongs to the lock, and to nothing else ---- */

console.log('\nwhat is worth asking again, and what is not');

const began = Date.now();
const notAgain = await caught(bdOf(HANGS).run(WS, ['list'], { timeout: 300, retries: 4 }));
const spent = Date.now() - began;
check('a timeout is never retried — the machine has just proved it is too busy', notAgain?.timedOut === true, String(notAgain));
check(
  'so four retries of a 300ms ceiling cost 300ms and not four of them',
  spent < 1500,
  `${spent}ms, which is more than one ceiling`
);

fs.rmSync(path.join(tmp, 'lock-calls'), { force: true });
const lock = await caught(bdOf(LOCKED).run(WS, ['comment', 'bc-1', 'hi'], { retries: 2 }));
const lockCalls = fs.existsSync(path.join(tmp, 'lock-calls')) ? fs.statSync(path.join(tmp, 'lock-calls')).size : 0;
check('a lock still is retried, because waiting is the fix for that one', lockCalls === 3, `bd ran ${lockCalls} times`);
check('and a lock that never clears is a failure, not a timeout', lock?.timedOut === false, String(lock?.timedOut));

/* ---- the other way a child gets killed ---- */

console.log('\nthe other killed child');

const flood = await caught(bdOf(FLOODS).run(WS, ['list', '--all']));
check(
  'blowing maxBuffer kills bd too, and that one really is broken output',
  flood instanceof Error && flood.timedOut === false,
  `${flood?.message} (timedOut ${flood?.timedOut})`
);
check('so it is not dressed up as a slow answer', !/timed out/i.test(flood?.message || ''), flood?.message);

/* ---- the three calls that go to the network, and to the lock as well ---- */

console.log('\nthe `bd dolt` verbs: two costs, and they used to be charged as one');

// bc-y3qk.2. These three were the only writes in lib/bd.js that retried nothing, argued
// from the one thing that makes them unlike the rest: they go to the network, and a retry
// of a two-minute network timeout is four minutes of a poll cycle. Sound about the
// network; silent about the *lock*, which is the other thing they queue behind — a hand
// run of `bd dolt pull` against the workspace with four logged 120s timeouts finished in
// four seconds, so the time was going to embedded Dolt's single writer and not to ssh.
//
// What makes retrying safe without giving that argument up is `run` itself: a timeout is
// never retried there, whatever `retries` says (asserted above). So a retry on these can
// only ever fire on LOCK_RE, and a killed call still costs exactly one ceiling.
const DOLT = [
  ['doltPull', (bd, opts) => bd.doltPull(WS, opts)],
  ['doltPush', (bd, opts) => bd.doltPush(WS, opts)],
  ['doltCommit', (bd, opts) => bd.doltCommit(WS, opts)],
];

for (const [name, call] of DOLT) {
  const bd = spied();
  await call(bd);
  const opts = bd.opts[0] || {};
  check(
    `${name} retries a lock rather than losing the whole tick to one`,
    Number(opts.retries) > 0,
    `asked for retries: ${opts.retries}`
  );
  check(
    `${name} defaults to the same ceiling as everything else, so a caller may say nothing`,
    (opts.timeout ?? BD_TIMEOUT) === BD_TIMEOUT,
    `asked for ${opts.timeout}`
  );

  // The ceiling has to be the *caller's*, because the number it must stay under is the
  // sync interval and lib/bd.js has never heard of that. A method that ignored the
  // argument would pass every assertion above and still put the skipped ticks back.
  const bd2 = spied();
  await call(bd2, { timeout: 4321 });
  check(
    `${name} takes a ceiling from its caller, which is the half lib/sync.js owns`,
    (bd2.opts[0] || {}).timeout === 4321,
    `asked for ${(bd2.opts[0] || {}).timeout}`
  );
}

// And end to end against a real child, because the retry is only worth anything if the
// spawn count moves: a lock is asked again, a hang is not.
fs.rmSync(path.join(tmp, 'lock-calls'), { force: true });
const doltLock = await caught(bdOf(LOCKED).doltPull(WS));
const doltCalls = fs.existsSync(path.join(tmp, 'lock-calls')) ? fs.statSync(path.join(tmp, 'lock-calls')).size : 0;
check('and a real `bd dolt pull` losing the lock is genuinely asked again', doltCalls > 1, `bd ran ${doltCalls} time(s)`);
check('a lock that never clears is still a failure and not a timeout', doltLock?.timedOut === false, String(doltLock?.timedOut));

const doltBegan = Date.now();
const doltHang = await caught(bdOf(HANGS).doltPull(WS, { timeout: 300 }));
const doltSpent = Date.now() - doltBegan;
check('while a hung one is killed at the ceiling its caller named', doltHang?.timedOut === true, String(doltHang));
check(
  'and costs one ceiling, not one per retry — the interval is still the retry',
  doltSpent < 1200,
  `${doltSpent}ms, which is more than one ceiling`
);

/* ------------------------------------------------------------------ verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
