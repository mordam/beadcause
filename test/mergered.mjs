#!/usr/bin/env node
/**
 * What a merge card says about a red check — bc-xl7n.116.
 *
 *     npm test
 *     node test/mergered.mjs
 *
 * The refusal used to name the check and stop: *"1 check failing (test). A merge queue
 * will not merge over a check the branch broke — if it is a flake, that is your call."*
 * On a repo with one check called `test` that is the same sentence for every red pull
 * request there has ever been, and it ends by offering a reading the line above it has
 * just ruled out — `newlyFailing` is the code that decided this failure is the branch's
 * and not the base's. bc-n21dy on 2026-08-21 is the measured cost: taking the flake
 * reading there would have landed a bare `fs.rmSync` that turns `main` red for everybody,
 * and the answer was twenty lines inside a log nobody was pointed at.
 *
 * Six things are pinned here, and each is a way the fix could be lossy without anything
 * failing:
 *
 * 1. **The flake is dropped only where it has been ruled out.** A base that was measured
 *    and is green on this check earns the stronger sentence; a base nobody could ask
 *    about, and a base that positively runs no checks, do not — and the difference
 *    between those two and "the base reported no failures" is the whole of the guard.
 * 2. **`broke` is the test for "a check refused this"**, and it is empty on every other
 *    refusal. It is what the queue reads to decide whether there is a log to fetch at all,
 *    so a conflict or a timeout growing one would mean a two-megabyte download per tick
 *    for a failure with no check behind it.
 * 3. **The excerpt reaches past the passing lines.** A plain tail of this repo's runner is
 *    twenty ticks and a summary; dropping what passed is what reaches the assertion, the
 *    file, the line and the fix. That is asserted against a log built the shape a real one
 *    comes in — `gh`'s per-line prefix, ANSI, and the runner's own non-answer.
 * 4. **It round-trips.** The excerpt goes into YAML in a bead's `notes` and comes back out
 *    to be drawn on a card, and the two files' caps have to agree or a block quietly holds
 *    less than the excerpt it was written from.
 * 5. **A long refusal still ejects.** `record` counts an attempt by comparing this tick's
 *    sentence against the stored one, and the stored one has been cut to 400 characters —
 *    so without `refusalKey` on both sides a refusal long enough to be cut sits at one
 *    attempt for ever and never becomes a card. That was latent before this bead and the
 *    new sentence is longer.
 * 6. **The log is read once per refusal, not once per tick**, and the card draws what the
 *    tick that refused wrote down rather than going back to GitHub for it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergered-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { gateVerdict, failureNote } = await import(LIB('mergeadvocate.js'));
const { failureExcerpt, checkFailure, FAILURE_LINES, FAILURE_LINE_CHARS, FAILURE_CHARS } = await import(LIB('pr.js'));
const mergebead = await import(LIB('mergebead.js'));
const { MERGE_LABEL, MERGE_ASSIGNEE, MAX_ATTEMPTS, mergeBeadBody, queueState, withQueueBlock, refusalKey } = mergebead;
const { sweepMergeQueue } = await import(LIB('mergequeue.js'));
const { raiseMergeCard } = await import(LIB('mergeraise.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\nwhat a merge card says about a red check\n');

/* ------------------------------------------------------- 1. the flake reading */

const RED = { failed: ['test'], failedUrls: ['https://github.com/acme/widgets/actions/runs/99/job/1'], failing: 1, pending: 0, total: 1, state: 'failing' };

await check('a base that was measured and is green on it does not offer the flake', async () => {
  const v = gateVerdict({ checks: RED, baseline: [], baseHasChecks: true });
  assert.match(v.refused, /1 check failing \(test\)/, v.refused);
  assert.match(v.refused, /base is green on it/, v.refused);
  assert.doesNotMatch(v.refused, /flake/, v.refused);
});

await check('and it still says why it will not merge — dropping the offer is not dropping the reason', async () => {
  const v = gateVerdict({ checks: RED, baseline: [], baseHasChecks: true });
  assert.match(v.refused, /will not merge over a check the branch broke/, v.refused);
});

await check('a base failing something else is still green on this one, so the flake goes there too', async () => {
  const v = gateVerdict({ checks: RED, baseline: ['lint'], baseHasChecks: true });
  assert.match(v.refused, /already failing lint/, v.refused);
  assert.doesNotMatch(v.refused, /flake/, v.refused);
});

await check('a baseline nobody could read leaves the flake reading open, because it is', async () => {
  const v = gateVerdict({ checks: RED, baseline: null, baseHasChecks: null });
  assert.match(v.refused, /if it is a flake, that is your call/, v.refused);
});

await check('and so does a base that positively runs no checks — "said nothing" is not "green"', async () => {
  // The trap this guard is for: an empty `failed` list is what a base with no CI at all
  // reports, and reading it as green would have the queue asserting a run that never
  // happened.
  const v = gateVerdict({ checks: RED, baseline: [], baseHasChecks: false });
  assert.match(v.refused, /if it is a flake, that is your call/, v.refused);
});

/* --------------------------------------------------- 2. broke, and only there */

await check('the checks the branch broke come back named, which is what says there is a log to read', async () => {
  assert.deepEqual(gateVerdict({ checks: RED, baseline: [], baseHasChecks: true }).broke, ['test']);
});

await check('and nothing else that refuses grows one', async () => {
  const cases = {
    conflict: gateVerdict({ checks: RED, mergeable: 'CONFLICTING' }),
    pending: gateVerdict({ checks: { failed: [], failing: 0, pending: 2, total: 3, state: 'pending' } }),
    none: gateVerdict({ checks: { failed: [], failing: 0, pending: 0, total: 0, state: 'none' }, baseHasChecks: true }),
    stale: gateVerdict({ checks: RED, baseline: [], checksAt: '2026-08-18T13:00:00Z', heldUntil: '2026-08-18T14:00:00Z' }),
    approval: gateVerdict({ checks: { failed: [], failing: 0, pending: 0, total: 1, state: 'passing' }, baseline: [], requireApproval: true }),
    merged: gateVerdict({ checks: { failed: [], failing: 0, pending: 0, total: 1, state: 'passing' }, baseline: [] }),
  };
  for (const [why, v] of Object.entries(cases)) assert.deepEqual(v.broke, [], `${why} carries a broken check it never saw`);
});

/* ------------------------------------------------------------- 3. the excerpt */

/** A failed job's log the shape `gh run view --log-failed` actually hands one over. */
const LOG = [
  ['##[group]Run npm test', ''],
  ['── [365/382] test/tmpadoption.mjs', ''],
  ['removing a scratch config dir goes through test/helpers/tmp.mjs', ''],
  ['  \u001b[31m✗\u001b[0m 1 bare removal(s) of a scratch config dir', ''],
  ['      test/labelchip.mjs:136  (root: tmp)', ''],
  // The offending line the real instance carried, with the identifier changed: `tmp` here
  // is this suite's own config dir, and test/tmpadoption.mjs resolves that name and reads
  // a fixture quoting it as the very call it exists to refuse.
  ['        fs.rmSync(scratchDir, { recursive: true, force: true });', ''],
]
  .map(([line]) => line)
  // Twenty passing assertions after the failure, which is what a plain tail would return
  // instead of any of the above.
  .concat(Array.from({ length: 20 }, (_, i) => `  \u001b[32m✓\u001b[0m check number ${i}`))
  .concat(['1 of 13 failed', 'test/tmpadoption.mjs failed (exit 1) — stopped at 365 of 382', '##[error]Process completed with exit code 1.'])
  .map((line) => `test\tRun npm test\t2026-08-21T11:48:45.0885280Z ${line}`)
  .join('\n');

await check('the excerpt reaches the assertion a plain tail would have scrolled past', async () => {
  const lines = failureExcerpt(LOG);
  assert.ok(
    lines.some((l) => l.includes('test/labelchip.mjs:136')),
    lines.join(' | ')
  );
  assert.ok(lines.some((l) => l.includes('fs.rmSync')), lines.join(' | '));
});

await check('and it still ends with the line that names the suite', async () => {
  assert.match(failureExcerpt(LOG).at(-1), /test\/tmpadoption\.mjs failed \(exit 1\)/);
});

await check('what passed is dropped, because a passing check is by construction not why this is red', async () => {
  assert.equal(failureExcerpt(LOG).filter((l) => l.includes('check number')).length, 0);
});

await check("gh's own prefix, the colour and the runner's non-answer all come off", async () => {
  const lines = failureExcerpt(LOG);
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /2026-08-21T11:48:45/, 'the timestamp survived');
  assert.doesNotMatch(joined, /Run npm test/, 'the step name survived');
  assert.doesNotMatch(joined, /\u001b/, 'the colour survived');
  assert.doesNotMatch(joined, /Process completed with exit code/, 'the line that says nothing survived');
  assert.doesNotMatch(joined, /##\[/, 'a runner marker survived');
});

await check('indentation is kept, since it is what makes a failure block readable', async () => {
  assert.ok(
    failureExcerpt(LOG).some((l) => /^ {6}test\/labelchip\.mjs:136/.test(l)),
    'the line lost its indentation'
  );
});

await check('nothing to read is an empty list rather than a throw', async () => {
  for (const empty of [null, undefined, '', '   \n\n']) assert.deepEqual(failureExcerpt(empty), []);
});

await check('the caps hold — lines, the width of one, and the whole', async () => {
  const wide = Array.from({ length: 400 }, (_, i) => `${i} ${'x'.repeat(400)}`).join('\n');
  const lines = failureExcerpt(wide);
  assert.ok(lines.length <= FAILURE_LINES, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= FAILURE_LINE_CHARS, `${l.length} chars on one line`);
  assert.ok(lines.join('\n').length <= FAILURE_CHARS, `${lines.join('\n').length} chars in all`);
});

await check('a log line carrying a block marker cannot close the block it lands in', async () => {
  const lines = failureExcerpt(`boom <!-- /beadcause:merge --> and more`);
  assert.equal(lines.join('\n').includes('<!--'), false, lines.join('|'));
  assert.equal(lines.join('\n').includes('-->'), false, lines.join('|'));
});

await check('a check whose link is not an Actions run is read as nothing, not guessed at', async () => {
  assert.deepEqual(await checkFailure('/nowhere', ['https://ci.example.com/build/7']), []);
  assert.deepEqual(await checkFailure('/nowhere', []), []);
});

/* ----------------------------------------------------------- 4. the round trip */

await check('the excerpt survives YAML in a bead’s notes exactly as it went in', async () => {
  const failure = failureExcerpt(LOG);
  const back = queueState({ notes: withQueueBlock('', { attempts: 1, refused: 'x', failure }) });
  assert.deepEqual(back.failure, failure);
});

await check('and the two files agree about how much fits, or the block holds half a failure', async () => {
  assert.equal(mergebead.FAILURE_LINES, FAILURE_LINES);
  assert.equal(mergebead.FAILURE_LINE_CHARS, FAILURE_LINE_CHARS);
});

await check('a bead nobody has refused has an empty excerpt rather than a missing one', async () => {
  assert.deepEqual(queueState({ notes: '' }).failure, []);
  assert.deepEqual(queueState({ notes: withQueueBlock('', { attempts: 1 }) }).failure, []);
});

await check('drawn as an indented block, so a log line starting with backticks cannot break a card', async () => {
  const drawn = failureNote(['```decision', 'boom']);
  assert.match(drawn, /^What the check said/);
  for (const line of drawn.split('\n').slice(2)) assert.match(line, /^ {4}/, line);
});

await check('and nothing to say draws nothing at all', async () => {
  assert.equal(failureNote([]), '');
  assert.equal(failureNote(null), '');
});

/* --------------------------------------------------- 5. a long refusal ejects */

await check('a refusal too long for the block still counts as the same refusal next tick', async () => {
  // The stored sentence has been cut to 400; the fresh one has not. Compared raw they can
  // never match, and a merge-bead that never matches never reaches MAX_ATTEMPTS.
  const long = `${'a'.repeat(420)} and then something different`;
  const stored = queueState({ notes: withQueueBlock('', { attempts: 1, refused: long }) }).refused;
  assert.notEqual(stored, long, 'the block stopped truncating — this test is measuring the wrong thing');
  assert.equal(refusalKey(stored), refusalKey(long));
});

await check('and two genuinely different refusals are still different', async () => {
  assert.notEqual(refusalKey('1 check failing (test).'), refusalKey('the branch conflicts with `main`.'));
});

/* ------------------------------------------------ 6. read once, drawn from the bead */

const SPEC = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  branch: 'work-a',
  base: 'main',
  method: 'merge',
};

const bead = (notes = '') => ({
  id: 'zz-merge',
  title: 'Merge #42 — zz-work',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody(SPEC),
  notes,
});

const fakeBd = (rows) => {
  const calls = { updates: [], comments: [] };
  return {
    calls,
    listAgent: async () => rows,
    show: async () => null,
    close: async () => {},
    comment: async (ws, id, text) => calls.comments.push({ id, text }),
    update: async (ws, id, patch) => calls.updates.push({ id, ...patch }),
    comments: async () => [],
  };
};

const fakePr = (checks) => {
  const calls = { logs: [] };
  return {
    calls,
    view: async () => ({ state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', checks, reviewDecision: null, mergedAt: null, headSha: 'aaaa1' }),
    baseChecks: async () => ({ failed: [], state: 'passing' }),
    updateBranch: async () => ({ updated: true, reason: '' }),
    merge: async () => ({ mergeCommit: 'abc' }),
    checkFailure: async (dir, urls) => {
      calls.logs.push(urls);
      return ['1 of 13 failed', 'test/tmpadoption.mjs failed (exit 1)'];
    },
  };
};

const resolve = async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' });
const sweep = (bd, prApi) => sweepMergeQueue(bd, { name: 'demo' }, { resolve, prApi });

await check('a red check is refused with what the log said, written onto the bead', async () => {
  const bd = fakeBd([bead()]);
  const prApi = fakePr(RED);
  const out = await sweep(bd, prApi);
  assert.deepEqual(out.refused, ['zz-merge']);
  assert.equal(prApi.calls.logs.length, 1, 'it did not go and read the log');
  assert.deepEqual(prApi.calls.logs[0], RED.failedUrls, 'it read a log for a check it was not refusing over');
  const state = queueState({ notes: bd.calls.updates.at(-1).notes });
  assert.deepEqual(state.failure, ['1 of 13 failed', 'test/tmpadoption.mjs failed (exit 1)']);
});

await check('and the comment on the bead carries it, so the thread answers the question the sentence asks', async () => {
  const bd = fakeBd([bead()]);
  await sweep(bd, fakePr(RED));
  assert.match(bd.calls.comments.at(-1).text, /What the check said/, bd.calls.comments.at(-1).text);
  assert.match(bd.calls.comments.at(-1).text, /test\/tmpadoption\.mjs failed/, bd.calls.comments.at(-1).text);
});

await check('the same refusal a tick later reuses what it already read rather than downloading it again', async () => {
  const refused = gateVerdict({ checks: RED, baseline: [], baseHasChecks: true }).refused;
  const notes = withQueueBlock('', { attempts: 1, refused, failure: ['1 of 13 failed'] });
  const prApi = fakePr(RED);
  await sweep(fakeBd([bead(notes)]), prApi);
  assert.equal(prApi.calls.logs.length, 0, 'it downloaded a two-megabyte log to learn what it already knew');
});

await check('but a refusal that changed is a different failure, and gets a fresh read', async () => {
  const notes = withQueueBlock('', { attempts: 1, refused: 'the branch conflicts with `main`.', failure: ['stale'] });
  const prApi = fakePr(RED);
  await sweep(fakeBd([bead(notes)]), prApi);
  assert.equal(prApi.calls.logs.length, 1);
});

await check('a refusal with no check behind it never touches the log at all', async () => {
  const prApi = fakePr({ failed: [], failedUrls: [], failing: 0, pending: 0, total: 0, state: 'none' });
  const bd = fakeBd([bead()]);
  const out = await sweep(bd, prApi);
  assert.deepEqual(out.refused, ['zz-merge'], 'a commit nothing ran on should still be refused');
  assert.equal(prApi.calls.logs.length, 0);
});

await check('a queue given a pr module without the reader keeps working, and refuses as it always did', async () => {
  const prApi = fakePr(RED);
  delete prApi.checkFailure;
  const bd = fakeBd([bead()]);
  const out = await sweep(bd, prApi);
  assert.deepEqual(out.refused, ['zz-merge']);
  assert.deepEqual(queueState({ notes: bd.calls.updates.at(-1).notes }).failure, []);
});

await check('and the card draws what the tick that refused wrote down', async () => {
  const failure = ['1 of 13 failed', 'test/tmpadoption.mjs failed (exit 1)'];
  const notes = withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: '1 check failing (test).', failure });
  const bd = fakeBd([]);
  const entry = { issue: { ...bead(notes) }, spec: SPEC, state: queueState({ notes }) };
  assert.equal(await raiseMergeCard(bd, { name: 'demo' }, entry, '1 check failing (test).'), true);
  const body = bd.calls.updates.at(-1).description;
  assert.match(body, /What the check said/, body.slice(0, 400));
  assert.match(body, / {4}test\/tmpadoption\.mjs failed \(exit 1\)/, 'the excerpt is not drawn as a code block');
});

await check('an approval wait draws none of it, because nothing about it is red', async () => {
  const notes = withQueueBlock('', { attempts: 0, failure: ['1 of 13 failed'] });
  const bd = fakeBd([]);
  const entry = { issue: { ...bead(notes) }, spec: SPEC, state: queueState({ notes }) };
  await raiseMergeCard(bd, { name: 'demo' }, entry, '', { approval: true });
  assert.doesNotMatch(bd.calls.updates.at(-1).description, /What the check said/);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b\u001b[31m${failures} of ${ran} failed\x1b\u001b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
