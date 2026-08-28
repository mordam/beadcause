#!/usr/bin/env node
/**
 * lib/bd.js — which of bd's sentences is worth asking again about, counted in spawns.
 *
 *     npm test
 *     node test/lockword.mjs
 *
 * `LOCK_RE` decides whether `run` retries, and it used to be a **substring** match on
 * `lock`:
 *
 *     const LOCK_RE = /(lock|locked|another process|resource busy|database is busy)/i;
 *
 * *blocks* and *blocked* both contain *lock*, and those are two of bd's commonest
 * refusals — a `dep add` over a pair that already holds an edge ends `(requested
 * "blocks")`, and a close over an open dependency says `blocked by open issues`. So
 * every one of them looked exactly like Dolt lock contention: a write with `retries: 4`
 * spent **five spawns and 400+800+1200+1600ms** proving something that was decided in
 * the first millisecond, and a sweep read spent three. Nothing failed and nothing warned
 * — the answer is identical either way, which is why it survived a year and turned up
 * only when a fixture expecting two `dep add`s watched ten go past (bc-arj0.20).
 *
 * The fix is one word boundary: `\block\w*` matches *lock*, *locked*, *locking* and
 * *lockfile*, and does not match *blocks* or *blocked*, because the boundary fails after
 * a `b`. `deadlock` is spelled out separately for the same reason in reverse.
 *
 * **The assertion is the spawn count, not the error.** Both families end in the same
 * rejection with the same sentence in it; the only observable difference is how many
 * times bd was asked, and how long the caller waited to be told. So every case here runs
 * a real `execFile` against a real fake `bd` — a script that prints one sentence, tallies
 * a byte and exits 1 — and counts the bytes. Nothing here touches a tracker, a bead or
 * the network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bd.js'), 'utf8');

const { Bd } = await import(path.join(ROOT, 'lib', 'bd.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-lockword-'));
const WS = { name: 'beadcause', dir: tmp };

let n = 0;
/**
 * A `bd` that says one sentence and keeps count of how often it was asked.
 *
 * One binary and one tally per case, so the cases may run concurrently — the roster of
 * lock spellings below waits out a real 400ms backoff each, and thirteen of those in
 * series is thirteen times the suite for no extra assertion.
 */
const sayer = (sentence) => {
  n += 1;
  const tally = path.join(tmp, `calls-${n}`);
  const file = path.join(tmp, `bd-${n}`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(tally)}, 'x');
process.stderr.write(${JSON.stringify(sentence)});
process.exit(1);
`,
    { mode: 0o755 }
  );
  return { file, tally };
};

/** Asks once with `retries` in hand, and answers with the number of `bd` processes it cost. */
const spawns = async (sentence, retries) => {
  const { file, tally } = sayer(sentence);
  const bd = new Bd({ bin: file, actor: 'beadcause-test' });
  try {
    await bd.run(WS, ['comment', 'bc-1', 'hi'], { retries });
  } catch {
    /* every sentence here is a failure; what is under test is how many times it was one */
  }
  return fs.existsSync(tally) ? fs.statSync(tally).size : 0;
};

/* ============================================== the refusals that used to cost four seconds */

console.log('\nwhat bd has already decided, asked once');

// Verbatim from the binary (bc-arj0.20 measured this one against a real workspace), and
// the sentence the whole bug was found through. `TERMINAL_RE` would decline this one too,
// which is why it is not on its own below.
const DEP_ADD =
  'Error: dependency bc-a -> bc-b already exists with type "relates-to" (requested "blocks"); ' +
  "remove it first with 'bd dep remove' then re-add";

// And the other family — a close over an open blocker. Nothing in `TERMINAL_RE` matches
// these, so they are the ones that prove the retry test itself is what declines them
// rather than the one-sentence guard beside it.
const REFUSALS = [
  ['a refused `dep add`, in bd’s own words', DEP_ADD],
  ['a close over an open dependency', 'cannot close bc-jrvh: blocked by open issues [bc-a0vc] (use --force to override)'],
  ['the other phrasing of the same refusal', 'cannot close bc-3muu.12: bc-3muu.12 is blocked by [bc-3muu.4]'],
  ['a filing-time validation refusal', 'validation failed: dependency → bc-eqn1.1 already exists with type "parent-child" (requested "blocks")'],
  ['the word on its own, with nothing else in the sentence to go on', 'Error: bc-a blocks bc-b'],
  ['and its past tense', 'Error: bc-a is blocked'],
];

const began = Date.now();
for (const [name, sentence] of REFUSALS) {
  const count = await spawns(sentence, 4);
  check(`${name} is asked once, not five times`, count === 1, `bd ran ${count} times for: ${sentence}`);
}
const spent = Date.now() - began;

// The count is the assertion; this is what the count was costing. One backoff alone was
// 400ms and the full four were 4000ms, per refusal, on a path with somebody holding a phone.
check(
  'so the whole roster costs less than a single retry’s backoff, let alone four',
  spent < 400 * REFUSALS.length,
  `${spent}ms across ${REFUSALS.length} refusals`
);

/* ================================================= and the one failure waiting does fix */

console.log('\nwhat only time can answer, still asked again');

// Embedded Dolt is single-writer and around twenty agent sessions share these workspaces,
// so this is the ordinary case, not the exotic one: the whole reason `retries` exists.
// Every spelling bd and Dolt have been seen to use, plus the two neighbours in `LOCK_RE`
// that never said "lock" at all.
const LOCKS = [
  ['the canonical Dolt refusal', 'dolt: database is locked by another process'],
  ['a bare lock', 'Error: failed to acquire lock'],
  ['at the start of the sentence, where there is no character before it', 'lock timeout exceeded'],
  ['the gerund', 'error: locking the database failed'],
  ['the file, which is a word `lock` is only the start of', 'could not remove lockfile /tmp/.dolt/sql-server.lock'],
  ['a deadlock, whose `lock` no leading boundary can ever reach', 'deadlock detected while writing'],
  ['and its participle', 'transaction rolled back: deadlocked'],
  ['the capitalised form, because the test is case-insensitive', 'Locked by another writer'],
  ['a second writer named rather than the lock it holds', 'error: another process is using this database'],
  ['resource busy', 'resource busy'],
  ['database is busy', 'database is busy'],
];

const locked = await Promise.all(LOCKS.map(([, sentence]) => spawns(sentence, 1)));
LOCKS.forEach(([name, sentence], i) => {
  check(`${name} is asked again`, locked[i] === 2, `bd ran ${locked[i]} time(s) for: ${sentence}`);
});

// And the count follows `retries` rather than being pinned at one more: a write asks four
// times over, a sweep read twice, and the narrowing must not have quietly capped either.
const twice = await spawns('dolt: database is locked', 2);
check('and a caller that asked for two retries gets three attempts', twice === 3, `bd ran ${twice} times`);

/* =============================================== the alternative that would bring it back */

console.log('\nthe regression that looks harmless');

// `blocked` contains `locked`, and `blocks` contains `lock`. So the way this comes back is
// not somebody deleting the boundary — it is somebody adding a spelling beside it as a
// bare substring, which reads like a widening and is a silent revert. Asserted per
// alternative rather than on the whole regex, because the whole regex is exactly what a
// new alternative keeps passing.
const line = SRC.split('\n').find((l) => l.startsWith('const LOCK_RE = '));
const literal = /^const LOCK_RE = \/\((.+)\)\/i;$/.exec(line || '');
check('LOCK_RE is still a single case-insensitive alternation this can read', Boolean(literal), line || '(no LOCK_RE line found)');

const alternatives = (literal?.[1] || '').split('|');
check('and it still has alternatives to check', alternatives.length >= 2, JSON.stringify(alternatives));

for (const alt of alternatives) {
  const re = new RegExp(alt, 'i');
  check(
    `\`${alt}\` does not fire on a refusal — bd’s words, not a contrived string`,
    !re.test(DEP_ADD) && !re.test('cannot close bc-jrvh: blocked by open issues [bc-a0vc]'),
    `${alt} matches a sentence bd has already decided`
  );
}

check(
  'and between them they still recognise a lock, so the narrowing did not just switch it off',
  ['database is locked', 'lockfile', 'deadlock', 'locking'].every((s) => alternatives.some((alt) => new RegExp(alt, 'i').test(s))),
  JSON.stringify(alternatives)
);

/* ------------------------------------------------------------------ verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
