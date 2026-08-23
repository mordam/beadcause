#!/usr/bin/env node
/**
 * Folding a verdict onto the review block: the pure translation bc-36xx.22 adds.
 *
 *     npm test
 *     node test/reviewsync.mjs
 *
 * lib/reviewadvocate.js owns the verdict comment; lib/mergebead.js owns the block the gate
 * reads; before this file existed nothing turned the first into the second. What matters
 * most here is not the happy path but the two ways this could go wrong quietly:
 *
 * 1. **The same verdict folded in twice.** `verdictFrom` always returns the newest comment
 *    that parses, whether or not the sweep already recorded it — a tick that ran a second
 *    later would otherwise re-fold the same round.
 * 2. **A verdict that reads as `refused`.** A ReviewAdvocate's own format has no such
 *    field, and a fold that invented one would let a single comment escalate a pull
 *    request straight to a card, skipping the round the worker is owed.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { freshVerdict, inlineComments, reviewFromVerdict, threadIdsFor } = await import(LIB('reviewsync.js'));
const { formatVerdict } = await import(LIB('reviewadvocate.js'));
const { reviewState, withReviewBlock } = await import(LIB('mergebead.js'));

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

console.log('\nfolding a verdict onto the review block\n');

/* ------------------------------------------------------------------- the world */

/** A verdict comment, exactly as a ReviewAdvocate would leave one. */
const verdictComment = (v) => ({ text: formatVerdict(v, { owner: 'Adam' }) });

const APPROVING = { pr: 42, bead: 'zz-work', round: 1, approved: true, comments: [] };
const CHANGES = {
  pr: 42,
  bead: 'zz-work',
  round: 1,
  approved: false,
  why: 'the lock is never released on the error path',
  comments: [
    { id: 'c1', file: 'lib/example.js', line: 42, severity: 'blocking', what: 'this leaks a handle', why: 'the finally never runs' },
    { id: 'c2', file: '', line: null, severity: 'question', what: 'why not a Set here', why: '' },
  ],
};

/* ---------------------------------------------------------------- freshVerdict */

await check('no comments at all is nothing fresh', () => {
  assert.equal(freshVerdict([], reviewState({})), null);
});

await check('a first verdict on a never-reviewed bead is fresh', () => {
  const v = freshVerdict([verdictComment(APPROVING)], reviewState({}));
  assert.ok(v);
  assert.equal(v.round, 1);
  assert.equal(v.approved, true);
});

await check('a verdict for a round the block already recorded is not fresh', () => {
  const state = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'approved', reviewedSha: 'aaaaaaa' }) });
  assert.equal(freshVerdict([verdictComment({ ...APPROVING, round: 1 })], state), null);
});

await check('and the same is true of an OLDER round than the block has', () => {
  const state = reviewState({ notes: withReviewBlock('', { round: 2, verdict: 'changes', reviewedSha: 'aaaaaaa' }) });
  assert.equal(freshVerdict([verdictComment({ ...CHANGES, round: 1 })], state), null);
});

await check('a round past what the block has recorded is fresh', () => {
  const state = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'changes', reviewedSha: 'aaaaaaa' }) });
  const v = freshVerdict([verdictComment({ ...CHANGES, round: 2 })], state);
  assert.ok(v);
  assert.equal(v.round, 2);
});

await check('the NEWEST parseable comment wins, exactly as verdictFrom already does', () => {
  const comments = [verdictComment({ ...CHANGES, round: 1 }), { text: 'unrelated chatter in between' }, verdictComment({ ...APPROVING, round: 2 })];
  const v = freshVerdict(comments, reviewState({}));
  assert.equal(v.round, 2);
  assert.equal(v.approved, true);
});

await check('a verdict checkVerdict cannot validate is nothing fresh, not a throw', () => {
  // Two comments sharing an id — checkVerdict refuses it outright.
  const broken = { ...CHANGES, comments: [{ id: 'c1', what: 'a' }, { id: 'c1', what: 'b' }] };
  assert.equal(freshVerdict([verdictComment(broken)], reviewState({})), null);
});

await check('a comment that is not a verdict at all is nothing fresh', () => {
  assert.equal(freshVerdict([{ text: 'looks good to me' }], reviewState({})), null);
});

/* ------------------------------------------------------------- reviewFromVerdict */

await check('an approval becomes verdict: approved, never verdict: refused', () => {
  const state = reviewFromVerdict(APPROVING, { headSha: 'beef1234', reviewer: 'NeanderthalMan' });
  assert.equal(state.verdict, 'approved');
  assert.equal(state.round, 1);
  assert.equal(state.reviewedSha, 'beef1234');
  assert.equal(state.reviewer, 'NeanderthalMan');
  assert.equal(state.refused, null);
  assert.deepEqual(state.comments, []);
});

await check('NOT approved becomes verdict: changes — NEVER refused, whatever it says', () => {
  // The ReviewAdvocate's own format has no way to say "I will never approve this" — that
  // escalation exists already, off the round cap (reviewEscalation), and this must not
  // invent a second, faster way to reach it from a single comment.
  const state = reviewFromVerdict(CHANGES, { headSha: 'beef1234' });
  assert.equal(state.verdict, 'changes');
  assert.notEqual(state.verdict, 'refused');
  assert.match(state.refused, /lock is never released/);
});

await check('the verdict\'s comments replace the block\'s wholesale, in its own shape', () => {
  const state = reviewFromVerdict(CHANGES, { headSha: 'beef1234' });
  assert.deepEqual(state.comments, [
    { id: 'c1', path: 'lib/example.js', line: 42, body: 'this leaks a handle', severity: 'blocking', why: 'the finally never runs' },
    { id: 'c2', path: '', line: null, body: 'why not a Set here', severity: 'question', why: '' },
  ]);
});

await check('round-tripped through the real block writer, it reads back the same', () => {
  const built = { ...reviewState({}), ...reviewFromVerdict(CHANGES, { headSha: 'beef1234', reviewer: 'NeanderthalMan' }) };
  const notes = withReviewBlock('', built);
  const read = reviewState({ notes });
  assert.equal(read.verdict, 'changes');
  assert.equal(read.round, 1);
  assert.equal(read.reviewedSha, 'beef1234');
  assert.equal(read.reviewer, 'NeanderthalMan');
  assert.equal(read.comments.length, 2);
  assert.equal(read.comments[0].severity, 'blocking');
  // Fresh from a verdict, so nothing has been answered or resolved yet.
  assert.equal(read.comments[0].answer, '');
  assert.equal(read.comments[0].resolved, false);
});

/* -------------------------------------------------------------- inlineComments */

await check('only comments a reviewer actually pointed at a file and line are inline', () => {
  const inline = inlineComments(CHANGES);
  assert.equal(inline.length, 1);
  assert.deepEqual(inline[0], { path: 'lib/example.js', line: 42, body: '**blocking** — this leaks a handle the finally never runs' });
});

await check('an approval with no comments has nothing to anchor, so nothing inline', () => {
  assert.deepEqual(inlineComments(APPROVING), []);
});

/* -------------------------------------------------------------- threadIdsFor */

/**
 * `threadIdsFor` — bc-36xx.31, the anchor that makes `resolveThread` (lib/pr.js) callable
 * at all. `reviewThreads`' own answer is matched back to a verdict's comments by path,
 * line and the exact text `inlineComments` sent, never by position — `reviewThreads`
 * makes no promise about the order GraphQL hands threads back in.
 */
const THREADS = [
  {
    id: 'PRRT_kwABC',
    resolved: false,
    comments: [{ id: '5551', path: 'lib/example.js', line: 42, body: '**blocking** — this leaks a handle the finally never runs' }],
  },
  {
    id: 'PRRT_kwXYZ',
    resolved: false,
    comments: [{ id: '5552', path: 'lib/other.js', line: 7, body: '**suggestion** — a nit unrelated to this verdict' }],
  },
];

await check('a comment matching path, line and exact posted text is anchored to its thread', () => {
  const map = threadIdsFor(CHANGES, THREADS);
  assert.equal(map.get('c1'), 'PRRT_kwABC');
});

await check('a comment with no file/line — the same ones inlineComments drops — is never looked up', () => {
  const map = threadIdsFor(CHANGES, THREADS);
  assert.equal(map.has('c2'), false);
});

await check('a comment GitHub never got back to yet is simply absent from the map, not a throw', () => {
  const solo = { ...CHANGES, comments: [{ id: 'c9', file: 'lib/nowhere.js', line: 1, severity: 'question', what: 'x', why: '' }] };
  const map = threadIdsFor(solo, THREADS);
  assert.equal(map.size, 0);
});

await check('threads read as null — the outage shape reviewThreads returns — anchors nothing rather than throwing', () => {
  const map = threadIdsFor(CHANGES, null);
  assert.equal(map.size, 0);
});

await check('reviewFromVerdict anchors threadId onto the matching comment when a map is given', () => {
  const map = threadIdsFor(CHANGES, THREADS);
  const state = reviewFromVerdict(CHANGES, { headSha: 'beef1234', threadIds: map });
  assert.equal(state.comments[0].threadId, 'PRRT_kwABC');
  // The unmatched comment carries no key at all — never an empty string — so a block
  // written from it round-trips exactly as one built with no threadIds ever did.
  assert.equal('threadId' in state.comments[1], false);
});

await check('with no threadIds passed at all, the shape is exactly what it always was', () => {
  const state = reviewFromVerdict(CHANGES, { headSha: 'beef1234' });
  assert.equal('threadId' in state.comments[0], false);
});

/* ------------------------------------------------------------------------ done */

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
