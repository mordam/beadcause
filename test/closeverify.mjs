#!/usr/bin/env node
/**
 * A close is not a close because `bd` exited 0 — `Bd.assertClosed`, and the guard beside it.
 *
 *     npm test
 *     node test/closeverify.mjs
 *
 * **bc-q6qc.** bc-3muu.12 merged as #339, took the comment `finish` in lib/mergequeue.js
 * writes immediately before the close, and sat `in_progress` for a day. Nothing anywhere
 * said so — no `[bd] … closing over the claim guard` line, no `[merge-queue] … but the
 * work bead did not close` line, an empty `owed-closes.json`. All three are written by
 * code either side of that one call, so their absence is the measurement: `bd close` came
 * back 0 and the row did not move. Every layer above reported the close as done, because
 * from an exit code there is nothing else it could have reported. That is bc-ec6's
 * failure class and it is the expensive one — a merged bead that reads as in flight does
 * not crash anything, it just quietly buys a second session on work that already landed.
 *
 * So this file asks the two questions that failure turns on, of a fake `bd` that can be
 * told to lie in exactly that way:
 *
 *   1. **Does a silent non-close come back as an error?** It must, on both the plain path
 *      and the forced one, and for `close` and `closeAnswered` alike — because every
 *      caller of those already knows how to log a throw, `oweClose` it and say so on the
 *      bead, and none of them can do anything at all with a lie.
 *   2. **Does it stay quiet when it should?** Three shapes must go through untouched: a
 *      real close, a tracker that will not answer the `show`, and a status this codebase
 *      has never heard of. Inventing a failure from any of those would park a landed bead
 *      in `owed-closes.json` to be retried every thirty seconds for ever, which is worse
 *      than the bug — so `LIVE_STATUSES` names what is *open* rather than what is closed,
 *      and this file pins that direction rather than the list.
 *
 * And the half that must **not** have widened. `--force` is what a matched claim guard
 * buys, and it lifts open children, live blockers and the epic gates with it. A silent
 * non-close is a close nobody can explain, so it must never force — the bottom third
 * asserts that the forced close is not even attempted, and that `CLAIM_GUARD_RE` still
 * says no to every gate refusal after gaining bd's *held by …* wording.
 *
 * The fake is a real executable, spawned by the real `Bd` through the real `run`, because
 * what is under test is precisely the seam between an exit code and a row — and a fake
 * `Bd` object could only ever confirm what this file already believes. test/answerclose.mjs
 * is the same shape for the refusal half, and test/closegatereal.mjs asks the binary
 * itself which of these sentences it actually says.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Bd, CLAIM_GUARD_RE, LIVE_STATUSES } = await import(path.join(HERE, '..', 'lib', 'bd.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-closeverify-'));
const WS = { name: 'closeverify', dir: path.join(tmp, '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

console.log('\na close that bd did not make\n');

/* ------------------------------------------------------------------ the fake bd */

/**
 * A `bd` that logs its argv, optionally refuses a close, and answers `show` with whatever
 * status the case wants — including the same one *after* a close that exited 0, which is
 * the whole lie under test.
 *
 * `after` is what `show` says once a close has been attempted, so a case can make the row
 * move (a real close) or stand still (the bug). `showRaw` overrides the payload outright,
 * for the tracker that will not answer at all. State lives in files beside the log because
 * each invocation is its own process.
 */
const fakeBd = (name, { refusal = null, forceRefusal = null, before = 'in_progress', after = 'closed', showRaw = null } = {}) => {
  const log = path.join(tmp, `${name}.log`);
  const closed = path.join(tmp, `${name}.closed`);
  const bin = path.join(tmp, name);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const tried = () => fs.existsSync(${JSON.stringify(closed)});
if (argv[0] === 'show') {
  ${showRaw === null ? '' : `process.stdout.write(${JSON.stringify(showRaw)}); process.exit(${showRaw === '' ? 1 : 0});`}
  const status = tried() ? ${JSON.stringify(after)} : ${JSON.stringify(before)};
  process.stdout.write(JSON.stringify([{ id: 'zz-work', title: 'a work bead', status }]));
  process.exit(0);
}
if (argv[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
if (argv[0] === 'dep') { process.stdout.write('[]'); process.exit(0); }
if (argv[0] === 'close') {
  const forced = argv.includes('--force');
  const say = forced ? ${JSON.stringify(forceRefusal)} : ${JSON.stringify(refusal)};
  if (say) { process.stderr.write(say); process.exit(1); }
  fs.writeFileSync(${JSON.stringify(closed)}, '1');
  process.stdout.write('closed');
  process.exit(0);
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

/** bd 1.2.1's own words, copied off the binary in test/closegatereal.mjs rather than paraphrased. */
const CLAIM_REFUSAL =
  'cannot close zz-work: assignee is "neadamthal@gmail.com", actor is "beadcause (neadamthal@gmail.com)"; reclaim or use --force to override';
/** The refusal that must never buy a `--force`, in bd 1.2.1's words. */
const BLOCKER_REFUSAL = 'cannot close zz-work: blocked by zz-other (open); close the blocker first or use --force';

const threw = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};
const closes = (list) => (list || []).filter((c) => c[0] === 'close');

/* ---------------------------------------------------- 1. the silent non-close */

{
  // The bug, in one case: `bd close` exits 0, the row does not move, and nothing else in
  // the world says a word about it.
  const { bd, calls } = fakeBd('silent', { after: 'in_progress' });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339 as 457341e1 into main on GitHub', { overClaim: true }));
  check(Boolean(err), 'a close bd exits 0 on and does not make — throws rather than passing for done', 'it returned normally');
  check(/still in_progress/.test(String(err?.message || '')), 'and the message says what the bead is still doing', String(err?.message || ''));
  check(/zz-work/.test(String(err?.message || '')), 'and names the bead, so the log line above it is findable', String(err?.message || ''));
  check(err?.unclosed === 'in_progress', 'and carries the status on the error, for a caller that wants to read it', JSON.stringify(err?.unclosed));
  // The reason `--force` is not the answer here: a close bd said nothing about is a close
  // nobody can explain, and forcing is a guess that also lifts children, blockers and the
  // epic gates. It has to leave as an owed close instead.
  check(closes(calls()).length === 1, 'and it does not reach for --force on a refusal bd never made', JSON.stringify(closes(calls())));
}

{
  // The same lie on the *forced* close, which is the end of the road: the claim guard
  // refused, `--force` was reached for, `--force` came back 0, and the bead is still open.
  const { bd, calls } = fakeBd('silentforce', { refusal: CLAIM_REFUSAL, after: 'in_progress' });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(Boolean(err), 'a --force that exits 0 and closes nothing — throws too', 'it returned normally');
  check(closes(calls()).some((c) => c.includes('--force')), 'and the force really was attempted first', JSON.stringify(closes(calls())));
}

{
  // A question, not a work bead. Same lie, and it matters at least as much: a card whose
  // close silently did not happen stays in the inbox having already been answered, which
  // is the shape bc-jrvh's three identical answers came out of.
  const { bd } = fakeBd('silentanswer', { after: 'open' });
  const err = await threw(() => bd.closeAnswered(WS, 'zz-work', 'Answered via Beadcause'));
  check(Boolean(err), 'an answered card whose close silently did not happen — throws', 'it returned normally');
  check(/still open/.test(String(err?.message || '')), 'and says so in bd’s own word for the status', String(err?.message || ''));
}

{
  // And the reclaim path of the same method: the claim guard refused, the assignee was
  // cleared, the second close exited 0 — and the row still has not moved.
  const { bd, calls } = fakeBd('silentanswerclaim', { refusal: CLAIM_REFUSAL, after: 'open' });
  const err = await threw(() => bd.closeAnswered(WS, 'zz-work', 'Answered via Beadcause'));
  check(Boolean(err), 'a reclaimed close that exits 0 and closes nothing — throws', 'it returned normally');
  check(
    calls().some((c) => c[0] === 'update' && c.includes('--assignee')),
    'and the reclaim it depends on still happened',
    JSON.stringify(calls())
  );
}

/* ------------------------------------------------------- 2. and it stays quiet */

{
  // The ordinary close, which is very nearly all of them: one `bd close`, one `bd show`,
  // no throw, and nothing about it in anyone's log.
  const { bd, calls } = fakeBd('happy');
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(!err, 'a close that really closed — passes', String(err?.message || ''));
  check(closes(calls()).length === 1, 'and costs exactly one close', JSON.stringify(closes(calls())));
  check(calls().some((c) => c[0] === 'show'), 'and one show, which is the whole price of asking', JSON.stringify(calls()));
}

{
  // A tracker that will not answer the `show`. "I cannot tell whether it closed" is not
  // "it did not close": failing here would put a bead that is closed into owed-closes.json
  // and retry it every thirty seconds for ever.
  const { bd } = fakeBd('deaf', { showRaw: '' });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(!err, 'a show that fails outright — is not evidence, and the close stands', String(err?.message || ''));
}

{
  // A row that has been renamed away between the close and the question. Same direction.
  const { bd } = fakeBd('gone', { showRaw: '[]' });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(!err, 'a bead the tracker no longer has — is not evidence either', String(err?.message || ''));
}

{
  // bd's done state is configurable, so a workspace may come back with a word this
  // codebase has never seen. `LIVE_STATUSES` names what is *open*, so an unfamiliar status
  // reads as closed — which can only ever miss this bug, never invent it.
  const { bd } = fakeBd('exotic', { after: 'resolved' });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(!err, 'a done status this codebase has never heard of — reads as closed, not as a failure', String(err?.message || ''));
  check(!LIVE_STATUSES.has('resolved') && LIVE_STATUSES.has('open'), 'because the set names what is open rather than what is done');
}

/* -------------------------------------------------- 3. and nothing widened towards --force */

{
  // Unchanged, and the assertion is here so a future widening of the silent case cannot
  // quietly take this with it: a blocker refusal is not a claim guard, does not force, and
  // travels out to the caller to become an owed close exactly as it always did.
  const { bd, calls } = fakeBd('blocked', { refusal: BLOCKER_REFUSAL });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339', { overClaim: true }));
  check(Boolean(err), 'a blocker refusal — still throws', 'it returned normally');
  check(!closes(calls()).some((c) => c.includes('--force')), 'and is still never forced', JSON.stringify(closes(calls())));
}

{
  // `overClaim` off is the caller saying "do not step over anything", and a verified close
  // must not have changed that either.
  const { bd, calls } = fakeBd('noover', { refusal: CLAIM_REFUSAL });
  const err = await threw(() => bd.close(WS, 'zz-work', 'Merged #339'));
  check(Boolean(err), 'the claim guard without overClaim — still throws', 'it returned normally');
  check(!closes(calls()).some((c) => c.includes('--force')), 'and still never forces', JSON.stringify(closes(calls())));
}

{
  // The regex gained bd's *held by …* wording (bc-q6qc's second half). What matters is not
  // that it matches — it is that it still refuses every sentence `--force` must never be
  // reached for, including the *reassign* refusal the wording was copied from.
  const yes = [
    ['the assignee/actor close refusal', CLAIM_REFUSAL],
    [
      'a close refused in the held-by wording',
      'cannot close bc-3muu.12: held by "neadamthal@gmail.com" (in_progress); coordinate with the holder (bd mail neadamthal@gmail.com) — pass --force only if their claim is abandoned',
    ],
  ];
  const no = [
    // The one actually observed, at line 42283 of ~/Library/Logs/beadcause.log on
    // 2026-08-16. It is a *reassign*, and a reassign is not a close: the advocate handles
    // it, and reading it as a claim guard would mean forcing a close nobody asked for.
    [
      'the reassign refusal it was copied from',
      'cannot reassign bc-3muu.12: held by "neadamthal@gmail.com" (in_progress); coordinate with the holder (bd mail neadamthal@gmail.com) — pass --force only if their claim is abandoned (crashed agent, expired lease), or use bd reclaim',
    ],
    ['open children', 'cannot close bc-x: 3 open child issue(s); close children first or use --force'],
    ['a live blocker', BLOCKER_REFUSAL],
    ['a pinned issue', 'cannot close bc-x: issue is pinned; use --force to override'],
  ];
  for (const [name, text] of yes) check(CLAIM_GUARD_RE.test(text), `the claim guard matches ${name}`, text);
  for (const [name, text] of no) check(!CLAIM_GUARD_RE.test(text), `the claim guard still says no to ${name}`, text);
}

/* ------------------------------------------------------ 4. the delivery, on the other door */

{
  // bin/deliver.js is a different process shelling out to `bd` synchronously, so it carries
  // its own copy of the check. What is asserted here is the thing that made two copies
  // worth having in the first place: they read the same list, so a status added to one is
  // added to both. The behaviour itself is exercised in test/redeliver.mjs.
  const src = fs.readFileSync(path.join(HERE, '..', 'bin', 'deliver.js'), 'utf8');
  check(/import \{[^}]*\bLIVE_STATUSES\b[^}]*\} from '\.\.\/lib\/bd\.js'/.test(src), 'the delivery imports the open-status list rather than restating it');
  check(/mustHaveClosed\(\)/.test(src), 'and asks whether its own close happened');
  check((src.match(/mustHaveClosed\(\);/g) || []).length >= 2, 'on the plain close and on the forced one alike');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
