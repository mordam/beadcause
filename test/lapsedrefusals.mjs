/**
 * Four ways a pull request stopped being the queue's problem without being anybody's —
 * bc-91srt, all four found working out why ten beadcause pull requests sat unmerged on
 * 2026-08-19.
 *
 * They are one suite because they are one failure wearing four faces: **the queue treats a
 * reason as permanent when it was only true once.** A refusal that lapsed still ejects; an
 * ejection is never revisited; three unlike refusals count as one stuck branch; and a
 * check measured against a base that has since been repaired is read as the branch's own.
 * Each of them ends the same way — a pull request in no list, waiting on a person who has
 * not been told there is anything to do.
 *
 * Everything here drives the pure functions rather than a daemon, for `gateVerdict`'s own
 * reason: what is under test is the decision an unattended queue makes about merging to
 * `main`, and a test must be able to reach every branch of it without a network, a
 * checkout or a pull request.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const { gateVerdict, cardedFor, strandedPrs, anyQueued, queueFor } = await import(LIB('mergeadvocate.js'));
const { queueState, queueBlock, withQueueBlock, MAX_RECLAIMS, MAX_ATTEMPTS } = await import(LIB('mergebead.js'));

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

/** A merge-bead, in the shape the selectors read. */
const bead = ({ id = 'zz-merge', labels = ['merge-queue'], status = 'open', notes = '', number = 42 } = {}) => ({
  id,
  status,
  labels,
  assignee: 'merge-advocate',
  notes,
  description: [
    '```beadpr',
    'workspace: beadcause',
    'bead: zz-work',
    'repo: beadcause',
    `number: ${number}`,
    `url: https://github.com/mordam/beadcause/pull/${number}`,
    'branch: worktree-thing',
    'base: main',
    'method: merge',
    '```',
  ].join('\n'),
});

const CARD = ['human', 'pr-delivery'];

/* ------------------------------------------------- 1. a base that is no longer there */

/**
 * The shape that condemned #475 and #488: the branch's own run is red, the base is green
 * *now*, and the run fired while the base was broken. Without the stamp this is
 * indistinguishable from a branch that broke the build.
 */
await check('a check that finished before the base came back is a wait, not a refusal', async () => {
  const v = gateVerdict({
    checks: { failed: ['test'], failing: 1, total: 1, state: 'failing' },
    baseline: [], // the base is green again, so its own failure has dropped out
    checksAt: '2026-08-18T13:59:51Z',
    heldUntil: '2026-08-18T14:17:00Z',
  });
  assert.equal(v.merge, false);
  assert.equal(v.stale, true, 'it is the stale branch, not the failing one');
  assert.match(v.refused, /no longer there/, v.refused);
  // The sentence must not accuse the branch — that is the whole failure being fixed.
  assert.doesNotMatch(v.refused, /the branch broke/, v.refused);
});

await check('and once the checks have run since, the same red is the branch’s own again', async () => {
  const v = gateVerdict({
    checks: { failed: ['test'], failing: 1, total: 1, state: 'failing' },
    baseline: [],
    checksAt: '2026-08-18T15:00:00Z',
    heldUntil: '2026-08-18T14:17:00Z',
  });
  assert.equal(v.stale, false);
  assert.match(v.refused, /1 check failing \(test\)/, v.refused);
});

await check('an unreadable stamp cannot answer the question, so the strict rule stands', async () => {
  for (const [checksAt, heldUntil] of [
    [null, '2026-08-18T14:17:00Z'],
    ['2026-08-18T13:59:51Z', null],
    ['not a date', '2026-08-18T14:17:00Z'],
    ['2026-08-18T13:59:51Z', 'not a date'],
  ]) {
    const v = gateVerdict({
      checks: { failed: ['test'], failing: 1, total: 1, state: 'failing' },
      baseline: [],
      checksAt,
      heldUntil,
    });
    assert.equal(v.stale, false, `unknown must not be read as stale: ${checksAt} / ${heldUntil}`);
    assert.match(v.refused, /check/, 'it falls through to the ordinary refusal');
  }
});

await check('a conflict still outranks it — the fix comes before the verdict', async () => {
  const v = gateVerdict({
    mergeable: 'CONFLICTING',
    checks: { failed: ['test'], failing: 1, total: 1, state: 'failing' },
    baseline: [],
    checksAt: '2026-08-18T13:59:51Z',
    heldUntil: '2026-08-18T14:17:00Z',
  });
  assert.equal(v.conflicted, true, 'a conflicted branch is handed to a resolver whatever its checks say');
  assert.equal(v.stale, false);
});

/* ------------------------------------------------------- 2. consecutive identical refusals */

/**
 * `record` is not exported — it is an implementation detail of the sweep — so what is
 * pinned here is the rule it implements, against the state block that carries it. The
 * behavioural half rides in test/mergequeue.mjs through the sweep itself.
 */
await check('the queue block carries an attempt count that a differing refusal restarts', async () => {
  // Three unlike refusals must never reach MAX_ATTEMPTS, which is the whole point.
  const sentences = ['1 check failing (test).', 'the branch conflicts with `main`.', '2 of 3 checks were still running.'];
  let state = queueState({ notes: '' });
  for (const refused of sentences) {
    const same = String(state.refused || '').replace(/\s+/g, ' ').trim() === refused.replace(/\s+/g, ' ').trim();
    state = queueState({ notes: withQueueBlock('', { ...state, attempts: same ? state.attempts + 1 : 1, refused }) });
  }
  assert.equal(state.attempts, 1, 'three different refusals are one attempt each, never a tally');
  assert.ok(state.attempts < MAX_ATTEMPTS, 'so nothing ejects');
});

await check('and the same refusal three times still ejects, which is what the cap is for', async () => {
  const refused = '1 check failing (test).';
  let state = queueState({ notes: '' });
  for (let i = 0; i < 3; i += 1) {
    const same = String(state.refused || '') === refused;
    state = queueState({ notes: withQueueBlock('', { ...state, attempts: same ? state.attempts + 1 : 1, refused }) });
  }
  assert.equal(state.attempts, MAX_ATTEMPTS, 'a branch stuck at one place still reaches the cap');
});

/* ------------------------------------------------------------------ 3. taking a card back */

await check('a carded bead with a recorded refusal is found, and a queued one is not', async () => {
  const carded = bead({ id: 'zz-card', labels: CARD, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) });
  const queued = bead({ id: 'zz-queued', notes: withQueueBlock('', { attempts: 1, refused: 'something' }) });
  const found = cardedFor([carded, queued]);
  assert.deepEqual(found.map((e) => e.issue.id), ['zz-card']);
  assert.equal(found[0].state.attempts, 3);
  assert.equal(found[0].spec.number, 42, 'and it carries the pull request, so the sweep can ask about it');
});

await check('a card the queue never refused is left alone — it is a decision, not a leak', async () => {
  // No queue block at all: a delivery card waiting on Adam, which the queue never touched.
  const delivery = bead({ id: 'zz-delivery', labels: CARD, notes: '' });
  assert.deepEqual(cardedFor([delivery]), [], 'nothing to withdraw, so nothing is taken');
});

await check('and neither is a closed one, or one belonging to somebody else', async () => {
  const closed = bead({ id: 'zz-closed', labels: CARD, status: 'closed', notes: withQueueBlock('', { refused: 'x' }) });
  const theirs = { ...bead({ id: 'zz-theirs', labels: CARD, notes: withQueueBlock('', { refused: 'x' }) }), assignee: 'someone-else' };
  assert.deepEqual(cardedFor([closed, theirs]), []);
});

await check('the reclaim counter survives a round trip and is capped', async () => {
  const state = queueState({ notes: withQueueBlock('', { attempts: 0, reclaims: 2, refused: null }) });
  assert.equal(state.reclaims, 2, 'it is on the bead, because a flapping check outlives a process');
  assert.equal(MAX_RECLAIMS, 3, 'the cap this suite is written against');
  // The block must not carry a zero on the ninety-nine per cent of beads nothing reclaimed.
  assert.doesNotMatch(queueBlock({ attempts: 0 }), /reclaims/, 'absent rather than nought');
});

/**
 * The gate that decides whether the sweep runs at all. Widening it is not a nicety: the
 * reclaim only ever acts on beads that have had `merge-queue` taken off them, so a
 * workspace whose merge-beads have all been carded would answer "nothing queued" for ever
 * and never reach the one function written to rescue them.
 */
await check('a workspace with nothing but cards still says there is work to do', async () => {
  const carded = bead({ id: 'zz-card', labels: CARD, notes: withQueueBlock('', { refused: '1 check failing (test).' }) });
  assert.equal(queueFor([carded]).queued.length, 0, 'the queue proper cannot see it — that is the trap');
  assert.equal(anyQueued({ beads: [carded] }), true, 'and this is what stops the sweep skipping it');
});

await check('an empty workspace still says there is nothing, so the gate keeps its point', async () => {
  assert.equal(anyQueued({ beads: [] }), false);
  assert.equal(anyQueued({ beads: [{ status: 'open', labels: ['human'], assignee: 'somebody-else' }] }), false);
  // Unknown stays a yes: a tracker that would not export must not quietly stop the queue.
  assert.equal(anyQueued({ error: 'boom' }), true);
});

/* ------------------------------------------------------------- 4. nothing is about it */

await check('an open pull request no merge-bead names is reported', async () => {
  const beads = [bead({ number: 42 })];
  const prs = [{ number: 42, state: 'OPEN' }, { number: 99, state: 'OPEN' }];
  assert.deepEqual(strandedPrs(prs, beads).map((p) => p.number), [99]);
});

await check('a card still counts as cover — a handover is not a strand', async () => {
  const beads = [bead({ number: 99, labels: CARD, notes: withQueueBlock('', { refused: 'x' }) })];
  assert.deepEqual(strandedPrs([{ number: 99, state: 'OPEN' }], beads), [], 'somebody has it; it is not lost');
});

await check('drafts and closed pull requests are not strands', async () => {
  const prs = [
    { number: 1, state: 'OPEN', isDraft: true },
    { number: 2, state: 'MERGED' },
    { number: 3, state: 'CLOSED' },
  ];
  assert.deepEqual(strandedPrs(prs, []), [], 'a draft is somebody still writing, and the rest are over');
});

await check('a closed merge-bead is not cover, because nothing is acting on it', async () => {
  const beads = [bead({ number: 7, status: 'closed' })];
  assert.deepEqual(strandedPrs([{ number: 7, state: 'OPEN' }], beads).map((p) => p.number), [7]);
});

/* ------------------------------------------------------------- the wiring, at the source */

const QUEUE = fs.readFileSync(LIB('mergequeue.js'), 'utf8');

await check('the sweep counts consecutive identical refusals rather than any three', async () => {
  assert.match(QUEUE, /const same = \(a, b\) =>/, 'record compares the sentence');
  assert.match(QUEUE, /same\(state\.refused, refused\) \? \(state\.attempts \|\| 0\) \+ 1 : 1/, 'and restarts on a different one');
});

await check('lifting a hold stamps when it lifted, and the gate is given both halves', async () => {
  assert.match(QUEUE, /held: false, refused: null, heldUntil: iso\(\)/, 'the lift records the moment');
  assert.match(QUEUE, /checksAt: view\.checks\?\.at \|\| null/, 'and the gate is told what the checks were measured against');
  assert.match(QUEUE, /heldUntil: state\.heldUntil \|\| null/);
});

await check('a stale verdict never reaches the writer that spends an attempt', async () => {
  const from = QUEUE.indexOf('if (verdict.stale)');
  const to = QUEUE.indexOf('await record(bd, ws, issue, state, verdict.refused');
  assert.ok(from > 0 && to > from, 'the stale wait is placed before the refusal is recorded');
  assert.match(QUEUE.slice(from, to), /out\.waiting\.push/, 'and it waits rather than refusing');
});

console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
