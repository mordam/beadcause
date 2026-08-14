#!/usr/bin/env node
/**
 * Answering a bead somebody claimed — the close that used to fail, and the answer that
 * used to be written three times because it did.
 *
 *     npm test
 *     node test/answerclose.mjs
 *
 * bd refuses a close whose actor is not the bead's assignee:
 *
 *     cannot close bc-jrvh: assignee is "neadamthal@gmail.com",
 *     actor is "beadcause (neadamthal@gmail.com)"; reclaim or use --force to override
 *
 * and those two strings can never be made equal — the actor is beadcause's byline, the
 * assignee is a git address, and every worker window claims its bead. `Bd.respond`
 * writes the comment *before* the close on purpose, so what came back to the phone was
 * an error over a question that had in fact been answered; the card stayed in the inbox
 * and got answered again. bc-jrvh carried the same answer three times over four
 * comments. That is bc-ko7n.
 *
 * **This is the answer half of a defect that was fixed in two places, hours apart.**
 * bc-9d37.13 widened five *delivery* paths to step over the same refusal with `--force`
 * and ruled a question out of them on purpose — "a card is answered, not delivered" —
 * which was right about the evidence and left this path broken. test/mergeclose.mjs
 * covers that half; this file covers `Bd.closeAnswered`, and the two differ on the
 * instrument for a reason spelled out over `closeAnswered` in lib/bd.js: forcing keeps
 * the assignee, which on a delivered bead is the record of who did the work and on a
 * question is an artifact of a worker window having touched a card.
 *
 * Two claims here, and they are separate:
 *
 *   - **The close recovers**, by dropping the claim and closing again. Adam chose that
 *     over `--force` on 2026-08-14, and the assertions say so in both directions: the
 *     reclaim happens, and `--force` never appears in any argv this path builds.
 *   - **The answer is written once**, whatever the close does. The reclaim fixes the one
 *     refusal we know about; `answerOnce` is what stops the *next* one duplicating an
 *     answer, because comment-first means any failure after the comment leaves a card
 *     that will be answered again.
 *
 * The real `bd` is never run — a fake records every argv and can be told which refusal
 * to give — so what is asserted is what beadcause would say to a tracker. Whether bd
 * actually behaves this way is test/closegatereal.mjs's job, against the binary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Bd, isClaimGuard } = await import(path.join(HERE, '..', 'lib', 'bd.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-answerclose-'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (pass, name, detail) => (pass ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the fake bd */

/**
 * A `bd` that logs its argv and refuses on demand.
 *
 * `refusal` is the stderr a `close` comes back with, and `refuseWhile` decides how long:
 * the claim refusal must stop once the assignee has been cleared, or the reclaim would
 * look like it worked when all it did was try twice. The fake keeps that state in a file
 * beside the log, because each invocation is its own process.
 *
 * `said` is what `bd comments` answers — the thread `answerOnce` reads before it writes.
 */
const fakeBd = (name, { refusal = null, sticky = false, said = [] } = {}) => {
  const log = path.join(tmp, `${name}.log`);
  const cleared = path.join(tmp, `${name}.cleared`);
  const bin = path.join(tmp, name);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const cleared = () => fs.existsSync(${JSON.stringify(cleared)});
if (argv[0] === 'update' && argv.includes('--assignee')) {
  fs.writeFileSync(${JSON.stringify(cleared)}, '1');
  process.stdout.write('updated');
  process.exit(0);
}
if (argv[0] === 'comments') { process.stdout.write(${JSON.stringify(JSON.stringify(said))}); process.exit(0); }
if (argv[0] === 'dep') { process.stdout.write('[]'); process.exit(0); }
if (argv[0] === 'close' && ${JSON.stringify(Boolean(refusal))} && (${sticky} || !cleared())) {
  process.stderr.write(${JSON.stringify(String(refusal || ''))});
  process.exit(1);
}
process.stdout.write('[]');
`,
    { mode: 0o755 }
  );
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { bd: new Bd({ bin, actor: 'beadcause (neadamthal@gmail.com)' }), calls };
};

const WS = { name: 'answerclose', dir: path.join(tmp, '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

/** The refusal, in bd 1.2.1's own words — copied off the binary, not paraphrased. */
const CLAIM =
  'cannot close bc-jrvh: assignee is "neadamthal@gmail.com", actor is "beadcause (neadamthal@gmail.com)"; ' +
  'reclaim or use --force to override';
/** The other refusal that suggests `--force`, and which nothing here may override. */
const BLOCKED = 'cannot close bc-jrvh: blocked by open issues [bc-a0vc] (use --force to override)';

const closes = (calls) => calls.filter((a) => a[0] === 'close');
const comments = (calls) => calls.filter((a) => a[0] === 'comment');
const reclaims = (calls) => calls.filter((a) => a[0] === 'update' && a.includes('--assignee') && a.includes(''));
const forced = (calls) => calls.filter((a) => a.includes('--force'));

console.log('\nanswering a bead somebody claimed\n');

/* ------------------------------------------------------- the refusal, recognised */

// `isClaimGuard` is bc-9d37.13's, shared with the five delivery paths and with
// bin/deliver.js. Asked again here rather than assumed, because the answer path now
// depends on it too and the two beads landed hours apart without seeing each other.
check(isClaimGuard(new Error(CLAIM)), 'the claim refusal is recognised, in bd 1.2.1’s exact words');
check(!isClaimGuard(new Error(BLOCKED)), 'a blocked-by refusal is not mistaken for it, though it also offers --force');
check(
  isClaimGuard(new Error(`bd close bc-jrvh --reason x failed in beadcause: ${CLAIM}`)),
  'it is still recognised inside the sentence `run` wraps it in'
);

/* --------------------------------------------------------------- reclaim, then close */

{
  const { bd, calls } = fakeBd('reclaims', { refusal: CLAIM });
  let threw = null;
  try {
    await bd.closeAnswered(WS, 'bc-jrvh', 'Answered via Beadcause');
  } catch (err) {
    threw = err;
  }
  const c = calls();
  check(!threw, 'a close bd refuses over the claim comes back as a close, not an error', String(threw?.message).split('\n')[0]);
  check(reclaims(c).length === 1, `the assignee is cleared exactly once (${reclaims(c).length})`);
  check(closes(c).length === 2, `the close is attempted, then attempted again (${closes(c).length})`);
  check(forced(c).length === 0, 'and --force is never passed — Adam chose reclaim over it');
  const order = c.findIndex((a) => a[0] === 'update') < c.map((a) => a[0]).lastIndexOf('close');
  check(order, 'the claim is dropped before the close that lands, not after it');
}

{
  const { bd, calls } = fakeBd('nothing-to-reclaim');
  await bd.closeAnswered(WS, 'bc-jrvh', 'Answered via Beadcause');
  const c = calls();
  check(closes(c).length === 1, 'a close bd permits is one spawn and no more');
  check(reclaims(c).length === 0, 'an unclaimed bead is never written to on its way out');
}

{
  const { bd, calls } = fakeBd('blocked', { refusal: BLOCKED, sticky: true });
  let threw = null;
  try {
    await bd.closeAnswered(WS, 'bc-jrvh', 'Answered via Beadcause');
  } catch (err) {
    threw = err;
  }
  const c = calls();
  check(Boolean(threw), 'a blocked bead still throws — that refusal is an objection, not a byline');
  check(String(threw?.message || '').includes('blocked by open issues'), 'and it throws in bd’s own words');
  check(reclaims(c).length === 0, 'nothing is written to a bead this close could not have finished');
  check(forced(c).length === 0, 'and no --force is smuggled in behind it');
}

{
  // The refusal survives the reclaim: bd is unhappy about something the clear cannot
  // fix. Two attempts and then an honest failure, rather than a loop.
  const { bd, calls } = fakeBd('stubborn', { refusal: CLAIM, sticky: true });
  let threw = null;
  try {
    await bd.closeAnswered(WS, 'bc-jrvh', 'Answered via Beadcause');
  } catch (err) {
    threw = err;
  }
  const c = calls();
  check(Boolean(threw), 'a refusal that outlives the reclaim is reported rather than retried forever');
  check(closes(c).length === 2, `and it is two closes, not more (${closes(c).length})`);
}

/* ------------------------------------------------------------------ answer, once */

{
  const { bd, calls } = fakeBd('respond', { refusal: CLAIM });
  await bd.respond(WS, 'bc-jrvh', 'Yes — do it the short way.');
  const c = calls();
  check(comments(c).length === 1, `answering a claimed bead writes exactly one comment (${comments(c).length})`);
  check(closes(c).length === 2 && reclaims(c).length === 1, 'and it closes, having dropped the claim');
  check(
    c.findIndex((a) => a[0] === 'comment') < c.findIndex((a) => a[0] === 'close'),
    'the answer is still written before the close — comment-first is unchanged'
  );
}

{
  // The duplicate this whole bead is about: the same answer arriving again on a card
  // that never left the inbox. The comment is already the last thing on the thread, so
  // the retry finishes the close instead of saying it twice.
  const answer = 'Yes — do it the short way.';
  const { bd, calls } = fakeBd('again', { refusal: CLAIM, said: [{ id: 1, text: 'an earlier note' }, { id: 2, text: answer }] });
  await bd.respond(WS, 'bc-jrvh', answer);
  const c = calls();
  check(comments(c).length === 0, `re-answering with the same words writes no second comment (${comments(c).length})`);
  check(closes(c).length === 2 && reclaims(c).length === 1, 'and it still does the half that had not happened — the close');
}

{
  const said = [{ id: 1, text: 'Yes — do it the short way.' }, { id: 2, text: 'a later note from somebody else' }];
  const { bd, calls } = fakeBd('buried', { said });
  await bd.respond(WS, 'bc-jrvh', 'Yes — do it the short way.');
  check(
    comments(calls()).length === 1,
    'the same words further up the thread are a real answer, and are written again'
  );
}

{
  const { bd, calls } = fakeBd('different', { said: [{ id: 1, text: 'Yes — do it the short way.' }] });
  await bd.respond(WS, 'bc-jrvh', 'No — do it the long way.');
  check(comments(calls()).length === 1, 'a different answer on an answered bead is written');
}

{
  // `comments` fails open — it swallows its own errors and answers `[]` — and the
  // direction that matters is which way the miss falls: an unreadable thread must not
  // eat the answer.
  const { bd, calls } = fakeBd('unreadable', { said: null });
  await bd.respond(WS, 'bc-jrvh', 'Yes.');
  check(comments(calls()).length === 1, 'a thread bd cannot read writes the answer rather than dropping it');
}

{
  const { bd, calls } = fakeBd('commission', { said: [{ id: 1, text: 'Build both.' }] });
  await bd.commission(WS, 'bc-jrvh', 'Build both.');
  const c = calls();
  check(comments(c).length === 0, 'a commission re-answered identically does not duplicate either');
  check(
    c.some((a) => a[0] === 'update' && a.includes('--status')),
    'and it still hands the work back'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures}/${ran} failed` : `${ran}/${ran} passed`}\n`);
process.exit(failures ? 1 : 0);
