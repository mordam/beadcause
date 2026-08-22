#!/usr/bin/env node
/**
 * The merge-bead: what a worker files instead of merging, and the queue state on it.
 *
 *     npm test
 *     node test/mergebead.mjs
 *
 * bc-r941.1, bc-36xx.2. Five things are worth a suite here and none of them is visible by
 * reading one function:
 *
 * 1. **The block is the delivery card's block.** A merge-bead carries `beadpr`, written
 *    by lib/delivery.js's serialiser and parsed by lib/delivery.js's parser, because the
 *    failure path hands a refused merge to Adam as exactly that card. Two serialisers for
 *    one block would drift into a card whose Merge button acts on a pull request the bead
 *    no longer names, so a round trip through both is asserted rather than assumed.
 * 2. **The state block is a *separate* block, and rewriting it must not touch anything
 *    else in `notes`.** The two have opposite lifetimes — identity written once, progress
 *    rewritten every tick — and the markers exist so a tick cannot eat a human's note.
 * 3. **The three names agree.** `MERGE_ASSIGNEE`, `MERGE_ADVOCATE` and the key in
 *    lib/foundation.js's BASELINES are the same string, deliberately not imported from
 *    one another (a cycle, which lib/agents.js already paid for once). An assignee typo
 *    is a merge-bead nothing ever picks up and no error anywhere — the exact failure a
 *    test catches and a comment does not.
 * 4. **One merge-bead per pull request.** `clearOpenCards` in bin/deliver.js exists
 *    because two cards on one delivery were each a blocker on the work bead's close. A
 *    merge-bead is a blocker *by construction*, so the same pile here is strictly worse.
 * 5. **Two state blocks share one field, and they are cut apart by their markers.** The
 *    review loop's round, the reviewer's comments and the worker's answers to them have a
 *    third lifetime — they survive an admission that resets the queue's counters — so they
 *    are a second block with a second parser. What is worth pinning is not the round trip
 *    but the *coexistence*: interleaved writes leave one of each block and a human's line
 *    intact, and neither parser can be made to read the other's YAML. The half of that
 *    which is about the admission itself lives in test/mergeadmit.mjs, where the reset is.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const {
  MERGE_LABEL,
  MERGE_ASSIGNEE,
  MAX_ATTEMPTS,
  QUEUE_OPEN,
  QUEUE_CLOSE,
  isMergeBead,
  mergeSpec,
  queueState,
  queueBlock,
  withQueueBlock,
  mergeBeadTitle,
  mergeBeadBody,
  openMergeBeadFor,
  REVIEW_OPEN,
  REVIEW_CLOSE,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_ROUNDS,
  reviewState,
  withReviewBlock,
  reviewApproved,
  reviewPending,
  commentsForWorker,
  commentsForReviewer,
  reviewEscalation,
} = await import(LIB('mergebead.js'));
const { MERGE_ADVOCATE } = await import(LIB('mergeadvocate.js'));
const { AGENTS } = await import(LIB('foundation.js'));
const { parseDelivery } = await import(LIB('delivery.js'));
const { SEVERITIES, isBlocking } = await import(LIB('reviewadvocate.js'));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\nthe merge-bead — a worker hands the merge over\n');

const spec = {
  workspace: 'beadcause',
  bead: 'bc-7qo',
  title: 'The thing the worker did',
  repo: 'mordam/beadcause',
  number: 42,
  url: 'https://github.com/mordam/beadcause/pull/42',
  branch: 'worktree-thing-a3f',
  base: 'main',
  method: 'merge',
  summary: 'What changed and why.',
  tests: 'npm test — 239 files, all green',
  risk: '',
};

/* --------------------------------------------------------------- the identity */

check('the body carries a beadpr block the delivery parser reads back unchanged', () => {
  const body = mergeBeadBody(spec, { tests: spec.tests });
  const back = parseDelivery(body);
  assert.ok(back && !back.error, `the block did not parse: ${back?.error}`);
  for (const field of ['workspace', 'bead', 'repo', 'number', 'url', 'branch', 'base', 'method']) {
    assert.equal(back[field], spec[field], `${field} did not survive the round trip`);
  }
  assert.equal(back.summary, spec.summary);
  assert.equal(back.tests, spec.tests);
});

check('and mergeSpec reads it off a row the way the sweep hands one over', () => {
  const row = { id: 'bc-zz1', description: mergeBeadBody(spec), notes: '', design: '' };
  const back = mergeSpec(row);
  assert.equal(back.number, 42);
  assert.equal(back.bead, 'bc-7qo');
});

check('a block that will not parse is an error, not an absence', () => {
  // The distinction is the whole safety of it: a merge-bead the queue reads as "nothing
  // here" is one it skips in silence for the rest of its life, where an error is a
  // sentence somebody can act on.
  const row = { id: 'bc-zz2', description: '```beadpr\n: : not yaml : :\n```' };
  const back = mergeSpec(row);
  assert.ok(back?.error, 'a broken block read as a bead with nothing behind it');
});

check('the title names the pull request first, because that is what the queue is of', () => {
  const t = mergeBeadTitle(spec);
  assert.match(t, /^Merge #42 — bc-7qo/);
  assert.ok(t.length <= 160);
});

check('and it does not say the bead twice', () => {
  // A beadcause pull request title *opens* with the bead id, so borrowing it wholesale
  // put the id in twice: `Merge #359 — bc-kneh: bc-kneh: A delivered pull request…`, which
  // is what the card in a hand actually said. The prefix comes off the borrowed half.
  const t = mergeBeadTitle({ number: 359, bead: 'bc-kneh', title: 'bc-kneh: A delivered pull request' });
  assert.equal(t, 'Merge #359 — bc-kneh: A delivered pull request');
});

check('a title that never carried the id is left exactly as it is', () => {
  // The github.com case: opened by hand, no prefix, and nothing here may invent one.
  assert.equal(mergeBeadTitle({ number: 12, bead: 'bc-x', title: 'Bump the runner' }), 'Merge #12 — bc-x: Bump the runner');
  assert.equal(mergeBeadTitle({ number: 12, bead: 'bc-x' }), 'Merge #12 — bc-x');
  assert.equal(mergeBeadTitle({ number: 12, title: 'no bead at all' }), 'Merge #12: no bead at all');
});

check('a dotted child id is stripped as a literal, not as a pattern', () => {
  assert.equal(mergeBeadTitle({ number: 8, bead: 'bc-eqn1.11', title: 'bc-eqn1.11 — dotted' }), 'Merge #8 — bc-eqn1.11: dotted');
  // `.` must not match `x`, or a title merely shaped like the id loses its first word.
  assert.equal(mergeBeadTitle({ number: 8, bead: 'bc-eqn1.11', title: 'bc-eqn1x11: other' }), 'Merge #8 — bc-eqn1.11: bc-eqn1x11: other');
});

check('the body says what depends on what — the first question anyone opening one has', () => {
  const body = mergeBeadBody(spec, { tests: spec.tests });
  assert.match(body, /bc-7qo depends on this bead/, 'it does not say what the dependency is for');
  assert.match(body, /close gate refuses a bead with an open blocker/, 'it does not say why the dependency is the rule');
});

/* ------------------------------------------------------------------ the label */

check('the label is what marks one, and nothing else does', () => {
  assert.equal(isMergeBead({ labels: [MERGE_LABEL] }), true);
  assert.equal(isMergeBead({ labels: ['pr-delivery'] }), false);
  assert.equal(isMergeBead({ labels: [] }), false);
  assert.equal(isMergeBead({}), false);
  // Whitespace, because labels arrive from bd as strings a human may have typed.
  assert.equal(isMergeBead({ labels: [` ${MERGE_LABEL} `] }), true);
});

/* ------------------------------------------------------------- the queue state */

check('a bead nothing has tried has been tried nought times, not null times', () => {
  const s = queueState({ notes: '' });
  assert.equal(s.attempts, 0);
  assert.equal(s.refused, null, 'refused must stay null — an empty sentence is a different state');
  assert.deepEqual(s.baseline, []);
  assert.equal(s.resolving, false);
});

check('the state survives a round trip through notes', () => {
  const notes = withQueueBlock('', {
    attempts: 2,
    refused: 'GitHub said the branch conflicts with its base.',
    at: '2026-08-14T12:00:00.000Z',
    baseline: ['test/reenter.mjs'],
    resolving: true,
  });
  const s = queueState({ notes });
  assert.equal(s.attempts, 2);
  assert.match(s.refused, /conflicts with its base/);
  assert.deepEqual(s.baseline, ['test/reenter.mjs']);
  assert.equal(s.resolving, true);
});

check('rewriting it leaves everything else in notes alone', () => {
  const before = withQueueBlock('A human wrote this line.\n\nAnd this one.', { attempts: 1 });
  const after = withQueueBlock(before, { attempts: 2 });
  assert.match(after, /A human wrote this line\./);
  assert.match(after, /And this one\./);
  assert.equal(queueState({ notes: after }).attempts, 2);
  // One block, not two stacked up — a tick per minute would otherwise grow the field
  // without bound.
  assert.equal(after.split(QUEUE_OPEN).length - 1, 1, 'the block was appended rather than replaced');
  assert.equal(after.split(QUEUE_CLOSE).length - 1, 1);
});

check('a block a human broke reads as untried rather than as exhausted', () => {
  // The safe direction: untried costs one more attempt, where "exhausted" silently
  // strands the pull request with nothing saying why.
  const notes = `${QUEUE_OPEN}\n: : not yaml : :\n${QUEUE_CLOSE}`;
  assert.equal(queueState({ notes }).attempts, 0);
});

check('the block is bounded — a refusal cannot grow notes without limit', () => {
  const s = queueState({ notes: withQueueBlock('', { attempts: 1, refused: 'x'.repeat(2000) }) });
  assert.ok(s.refused.length <= 400, `a 2000-character refusal survived at ${s.refused.length}`);
});

/* ------------------------------------------------------------ the review state */

const reviewed = {
  round: 2,
  verdict: 'changes',
  reviewer: 'NeanderthalMan',
  at: '2026-08-17T10:00:00.000Z',
  comments: [
    { id: 'rc1', path: 'lib/x.js', line: 12, body: 'This swallows the error.', answer: 'declined', note: 'It is deliberate — see the comment above it.' },
    { id: 'rc2', body: 'Name it after what it does.', answer: 'changed', resolved: true },
    { id: 'rc3', body: 'What is this branch for?' },
  ],
};

check('a pull request nobody has reviewed has been reviewed nought times, and has no verdict', () => {
  const s = reviewState({ notes: '' });
  assert.equal(s.round, 0);
  assert.equal(s.verdict, null, 'a null verdict is what holds the merge — it must not default to anything');
  assert.equal(s.refused, null, 'refused must stay null, like the queue block: an empty sentence is a bug worth seeing');
  assert.deepEqual(s.comments, []);
});

check('the review survives a round trip through notes, comments and answers included', () => {
  const s = reviewState({ notes: withReviewBlock('', reviewed) });
  assert.equal(s.round, 2);
  assert.equal(s.verdict, 'changes');
  assert.equal(s.reviewer, 'NeanderthalMan');
  assert.equal(s.at, '2026-08-17T10:00:00.000Z');
  assert.deepEqual(
    s.comments.map((c) => [c.id, c.path, c.line, c.answer, c.resolved]),
    [
      ['rc1', 'lib/x.js', 12, 'declined', false],
      ['rc2', '', null, 'changed', true],
      ['rc3', '', null, '', false],
    ]
  );
  assert.match(s.comments[0].note, /It is deliberate/);
  // Serialise -> parse -> serialise is a fixed point, which is what makes the block safe
  // to rewrite every round: anything that shifted on the second pass would drift a field
  // at a time over the life of a review.
  assert.equal(withReviewBlock('', s), withReviewBlock('', reviewed));
  assert.deepEqual(reviewState({ notes: withReviewBlock('', s) }), s);
});

check('a comment carries its severity, its why and its GitHub thread id through the round trip', () => {
  // The gap this closes: a verdict comment (lib/reviewadvocate.js's checkVerdict) has
  // {severity, why} and this block used to have nowhere to put either, so a worker reading
  // the block back could not tell a blocking comment from a suggestion.
  const withFields = {
    round: 1,
    comments: [
      { id: 'x1', path: 'lib/y.js', line: 3, body: 'this leaks a handle', severity: 'blocking', why: 'it is called in a loop', threadId: 'RT_abc123==' },
      { id: 'x2', body: 'consider a shorter name', severity: 'suggestion' },
      { id: 'x3', body: 'no severity at all' },
    ],
  };
  const s = reviewState({ notes: withReviewBlock('', withFields) });
  assert.deepEqual(
    s.comments.map((c) => [c.severity, c.why, c.threadId]),
    [
      ['blocking', 'it is called in a loop', 'RT_abc123=='],
      ['suggestion', '', ''],
      ['', '', ''],
    ]
  );
  assert.equal(isBlocking(s.comments[0]), true, 'the shared isBlocking predicate reads a block comment too');
  assert.equal(isBlocking(s.comments[1]), false);
  // Fixed point, same as the rest of this block: a round trip must not shift a field.
  assert.equal(withReviewBlock('', s), withReviewBlock('', withFields));
});

check('a severity nothing recognises lands as a defined unknown, not the raw value and not a dropped comment', () => {
  const s = reviewState({
    notes: withReviewBlock('', { round: 1, comments: [{ id: 'y1', body: 'still a comment', severity: 'urgent!!' }] }),
  });
  assert.equal(s.comments.length, 1, 'an unrecognised severity must not be grounds to drop the comment');
  assert.equal(s.comments[0].severity, '', 'the raw garbage value must never be trusted through');
  assert.ok(!SEVERITIES.includes('urgent!!'), 'sanity: the fixture really is outside the closed set');
});

check('the two blocks live in one notes field and neither eats the other', () => {
  // The whole reason for two marker pairs. A tick rewrites the queue's progress; the
  // reviewer rewrites the review; a human's line outlives both.
  let notes = withQueueBlock('A human wrote this line.', { attempts: 1 });
  notes = withReviewBlock(notes, reviewed);
  notes = withQueueBlock(notes, { attempts: 2, refused: 'lint is red.' });
  notes = withReviewBlock(notes, { ...reviewed, round: 3 });

  assert.match(notes, /A human wrote this line\./);
  assert.equal(queueState({ notes }).attempts, 2);
  assert.equal(queueState({ notes }).refused, 'lint is red.');
  assert.equal(reviewState({ notes }).round, 3);
  assert.equal(reviewState({ notes }).comments.length, 3, "the queue's rewrite ate the review comments");
  // One of each, not a stack: two writers per bead per tick would otherwise grow the field
  // without bound.
  for (const marker of [QUEUE_OPEN, QUEUE_CLOSE, REVIEW_OPEN, REVIEW_CLOSE]) {
    assert.equal(notes.split(marker).length - 1, 1, `${marker} appears more than once`);
  }
});

check('and the review block is not inside the queue block, whatever order they were written in', () => {
  // A `beadcause:review` block that landed between QUEUE_OPEN and QUEUE_CLOSE would be
  // cut out wholesale by the next tick's `withQueueBlock`, and nothing would say so.
  const notes = withQueueBlock(withReviewBlock('', reviewed), { attempts: 1 });
  const q = notes.indexOf(QUEUE_OPEN);
  const qEnd = notes.indexOf(QUEUE_CLOSE);
  const r = notes.indexOf(REVIEW_OPEN);
  assert.ok(r >= 0 && q >= 0, 'both blocks must be present');
  assert.ok(r > qEnd || r < q, 'the review block sits inside the queue block');
  assert.equal(reviewState({ notes: withQueueBlock(notes, { attempts: 2 }) }).round, 2);
});

check('a block that lost its closing marker stops at the next block, not at the end of the field', () => {
  // How `notes` actually breaks: somebody edits the field and takes half a marker with
  // them. With one block in it that cost a human's note; with two, the next write of the
  // damaged block deletes the whole of the other one — and for the review block that is a
  // merge-bead forgetting a review it has had, with nothing anywhere saying so.
  const notes = `${QUEUE_OPEN}\nattempts: 2\n\n${withReviewBlock('', reviewed)}`;
  const after = withQueueBlock(notes, { attempts: 3 });
  assert.equal(reviewState({ notes: after }).round, 2, 'an unclosed queue block ate the review block');
  assert.equal(queueState({ notes: after }).attempts, 3);
  assert.equal(after.split(QUEUE_OPEN).length - 1, 1, 'the damaged block was left behind as well as rewritten');

  // And the same the other way round, because either block can be the damaged one.
  const other = withReviewBlock(`${REVIEW_OPEN}\nround: 1\n\n${withQueueBlock('', { attempts: 4 })}`, reviewed);
  assert.equal(queueState({ notes: other }).attempts, 4, 'an unclosed review block ate the queue block');
  assert.equal(reviewState({ notes: other }).round, 2);

  // What follows no marker at all is still given up: there is nothing to cut to, and
  // guessing where a block ends inside somebody's prose is worse than losing the tail.
  assert.equal(withQueueBlock(`${QUEUE_OPEN}\nattempts: 1`, { attempts: 2 }), withQueueBlock('', { attempts: 2 }));
});

check('a verdict nothing recognises reads as no verdict at all', () => {
  // The safe direction here is the opposite of the queue block's, and deliberately so: an
  // unparseable queue block costs one more attempt, where an unrecognised review verdict
  // must never be what lets an unreviewed pull request through the gate.
  assert.equal(reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'lgtm' }) }).verdict, null);
  const broken = `${REVIEW_OPEN}\n: : not yaml : :\n${REVIEW_CLOSE}`;
  assert.equal(reviewState({ notes: broken }).verdict, null);
  assert.equal(reviewState({ notes: broken }).round, 0);
});

check('an unanswered comment is not a declined one', () => {
  // Flattening the two is how every objection a worker never got to would read as settled.
  const s = reviewState({ notes: withReviewBlock('', reviewed) });
  assert.deepEqual(commentsForWorker(s).map((c) => c.id), ['rc3'], 'the worker owes an answer on exactly the unanswered ones');
  assert.deepEqual(
    commentsForReviewer(s).map((c) => c.id),
    ['rc1'],
    'the reviewer owes a look at the answered-but-unresolved ones — a change made is still a change to check'
  );
  const nonsense = reviewState({ notes: withReviewBlock('', { round: 1, comments: [{ id: 'x', body: 'y', answer: 'shipped' }] }) });
  assert.equal(nonsense.comments[0].answer, '', 'an answer outside the three reads as unanswered');
  assert.deepEqual(commentsForWorker(nonsense).map((c) => c.id), ['x']);
});

check('the approval is carried only when there is one', () => {
  const approved = reviewState({
    notes: withReviewBlock('', {
      round: 2,
      verdict: 'approved',
      reviewer: 'NeanderthalMan',
      approvedBy: 'NeanderthalMan',
      approvedAt: '2026-08-17T11:00:00.000Z',
      approvalUrl: 'https://github.com/mordam/beadcause/pull/42#pullrequestreview-1',
    }),
  });
  assert.equal(reviewApproved(approved), true);
  assert.equal(reviewPending(approved), false);
  assert.equal(approved.approvedBy, 'NeanderthalMan');
  assert.match(approved.approvalUrl, /pullrequestreview-1/, 'the approval must point at where a person can read it');

  // Not on every merge-bead in the workspace, for `queueBlock`'s reason: a block carrying
  // an empty approval on the ninety-nine per cent that never had one reads as a queue that
  // asks for reviews it does not.
  assert.ok(!/approved/.test(withReviewBlock('', { round: 0 })), 'an unreviewed bead carries approval fields');
  const claimed = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'changes', approvedBy: 'somebody' }) });
  assert.equal(claimed.approvedBy, '', 'an approver survived on a bead with no approval on it');
  assert.equal(reviewPending(reviewState({ notes: '' })), true);
});

check('the reviewed commit is carried for every verdict, not only for an approval', () => {
  // bc-36xx.10, and the "not only" is the whole of it. A `changes` verdict needs the sha
  // just as much as an approval: it is what a later round compares the head against to
  // tell whether the worker actually pushed anything in answer, or answered in prose.
  const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  for (const verdict of ['changes', 'approved', 'refused']) {
    const s = reviewState({
      notes: withReviewBlock('', { round: 1, verdict, refused: verdict === 'refused' ? 'no.' : '', reviewedSha: sha }),
    });
    assert.equal(s.reviewedSha, sha, `the sha was dropped on a '${verdict}' verdict`);
  }
  // Round trip and fixed point, like the rest of the block.
  const state = reviewState({ notes: withReviewBlock('', { ...reviewed, reviewedSha: sha }) });
  assert.equal(state.reviewedSha, sha);
  assert.deepEqual(reviewState({ notes: withReviewBlock('', state) }), state);
});

check('a bead written before the field existed reads as not knowing what was reviewed', () => {
  // The whole point of the default. An approval with no sha is one we cannot say what was
  // approved *of*, and bc-36xx.4 must be able to tell that from an approval of this head
  // — with no branch protection on this repo, GitHub leaves the approval standing when
  // new commits land, so "no sha" and "the current sha" are opposite answers.
  assert.equal(reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'approved' }) }).reviewedSha, '');
  assert.equal(reviewState({ notes: '' }).reviewedSha, '');
  // A branch name, a URL, a truncated paste — anything that is not a sha reads as absent,
  // which holds the merge rather than releasing it.
  for (const junk of ['not-a-sha', 'HEAD', '1c0ffee', 'z'.repeat(40), '0123456789abcdef'.repeat(4)]) {
    const s = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'approved', reviewedSha: junk }) });
    if (junk === '1c0ffee') assert.equal(s.reviewedSha, '1c0ffee', 'the short sha gh hands back was rejected');
    else assert.equal(s.reviewedSha, '', `'${junk.slice(0, 12)}' was taken for a commit`);
  }
  // And it is not written onto the beads that have none, for `approvedBy`'s reason.
  assert.ok(!/reviewedSha/.test(withReviewBlock('', { round: 0 })), 'an unreviewed bead carries a reviewed sha');
});

check('a refusal is its own verdict, and it is a sentence', () => {
  const s = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'refused', refused: 'r'.repeat(2000) }) });
  assert.equal(s.verdict, 'refused');
  assert.ok(s.refused.length <= 400, `a 2000-character refusal survived at ${s.refused.length}`);
});

check('the block is bounded — a reviewer cannot grow notes without limit', () => {
  const many = Array.from({ length: MAX_REVIEW_COMMENTS + 5 }, (_, i) => ({
    id: `rc${i}`,
    body: 'x'.repeat(3000),
    // Every one past the cap is resolved, so the cap has something it is allowed to drop.
    resolved: i < 5,
  }));
  const s = reviewState({ notes: withReviewBlock('', { round: 1, comments: many }) });
  assert.equal(s.comments.length, MAX_REVIEW_COMMENTS);
  assert.ok(s.comments[0].body.length <= 600, `a 3000-character comment survived at ${s.comments[0].body.length}`);
  // What is dropped is history, never an objection: an unresolved comment falling off the
  // end is a review that silently passed.
  assert.equal(s.comments.filter((c) => !c.resolved).length, MAX_REVIEW_COMMENTS, 'the cap dropped an unresolved comment');
});

check('a comment with nothing in it is not a comment', () => {
  // It would be a round nobody can finish: unanswerable, and unresolved forever.
  const s = reviewState({ notes: withReviewBlock('', { round: 1, comments: [{ id: 'a', body: '  ' }, null, 'a bare string', { id: 'b', body: 'real' }] }) });
  assert.deepEqual(s.comments.map((c) => c.body), ['a bare string', 'real']);
  assert.equal(s.comments[0].id, 'c3', 'a comment with no id must still be keyed, or an answer cannot be matched back');
});

/* ------------------------------------------------------------- who it goes to */

check('the assignee, the kind id and the foundation key are one string', () => {
  assert.equal(MERGE_ASSIGNEE, MERGE_ADVOCATE);
  assert.ok(
    AGENTS.includes(MERGE_ASSIGNEE),
    'a merge-bead is assigned to something that is not an agent kind — nothing will ever pick it up'
  );
});

/* -------------------------------------------------- one merge-bead per request */

const row = (id, d, extra = {}) => ({
  id,
  status: 'open',
  labels: [MERGE_LABEL],
  description: mergeBeadBody({ ...spec, ...d }),
  ...extra,
});

check('a re-delivery finds the merge-bead already open for the same pull request', () => {
  const rows = [row('bc-m1', {}), row('bc-m2', { number: 99, url: 'https://github.com/mordam/beadcause/pull/99', bead: 'bc-other' })];
  const found = openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' });
  assert.deepEqual(found.map((f) => f.id), ['bc-m1']);
});

check('and the one for the same work bead on an abandoned branch', () => {
  // The pull request number alone misses this: a session that abandoned its branch and
  // delivered the same bead on a new one leaves the first merge-bead pointing at a pull
  // request nobody is going to merge.
  const rows = [row('bc-m1', { number: 41, url: 'https://github.com/mordam/beadcause/pull/41' })];
  const found = openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' });
  assert.deepEqual(found.map((f) => f.id), ['bc-m1']);
  assert.equal(found[0].number, 41, 'it must say which request it found, or the close reason looks like a mistake');
});

check('a closed one is not found, and neither is a bead that is not a merge-bead', () => {
  const rows = [row('bc-m1', {}, { status: 'closed' }), { ...row('bc-m2', {}), labels: ['pr-delivery'] }];
  assert.deepEqual(openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' }), []);
});

check('nothing to compare matches nothing — not everything', () => {
  // The worst thing this could do: a caller with neither half known closing every open
  // merge-bead in the workspace.
  assert.deepEqual(openMergeBeadFor([row('bc-m1', {})], {}), []);
});

check('a different repo with the same number is a different pull request', () => {
  const rows = [row('bc-m1', { repo: 'mordam/other', url: 'https://github.com/mordam/other/pull/42', bead: 'zz-1' })];
  assert.deepEqual(openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42 }), []);
});

/* --------------------------------------------------------------------- limits */

check('MAX_ATTEMPTS is small enough that a stuck merge reaches a person', () => {
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 5, `${MAX_ATTEMPTS} attempts is not a retry, it is a loop`);
});

check('MAX_REVIEW_ROUNDS is Adam\'s two — review, answer, re-review, escalate', () => {
  assert.equal(MAX_REVIEW_ROUNDS, 2, 'bc-nq0m answered two; changing it is a decision, not a tuning');
});

check('A WORKER AND A REVIEWER THAT NEVER AGREE REACH A PERSON, and do not loop', () => {
  // bc-36xx.7, and the only property that actually matters here. Drive the loop the way
  // it really runs — the reviewer comments, the worker declines, the reviewer comments
  // again — and assert it stops. A cap that let this run is a session per round per side,
  // for ever, and from outside it is indistinguishable from the pull request being stuck.
  let state = reviewState({ notes: '' });
  let rounds = 0;
  const stopped = [];
  while (rounds < 10) {
    // The reviewer's round: it reads the diff and is still not satisfied.
    rounds += 1;
    state = reviewState({
      notes: withReviewBlock('', {
        ...state,
        round: rounds,
        verdict: 'changes',
        reviewer: 'NeanderthalMan',
        comments: [{ id: 'rc1', body: 'This swallows the error.' }],
      }),
    });
    if (reviewEscalation(state)) {
      stopped.push(rounds);
      break;
    }
    // The worker's answer: it declines, which is one of the three answers it is allowed.
    state = reviewState({
      notes: withReviewBlock('', {
        ...state,
        comments: state.comments.map((c) => ({ ...c, answer: 'declined', note: 'It is deliberate.' })),
      }),
    });
  }
  assert.deepEqual(stopped, [MAX_REVIEW_ROUNDS], `the disagreement ran ${rounds} rounds without reaching anybody`);
  assert.match(reviewEscalation(state), /did not agree/);
  assert.match(reviewEscalation(state), /still unresolved/, 'the card does not say what is outstanding');
});

check('a flat refusal escalates on round one, without waiting out the cap', () => {
  // Waiting for a second round would be asking a worker to answer comments that nobody is
  // going to accept whatever it writes.
  const s = reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'refused', refused: 'This belongs in lib/pr.js.' }) });
  assert.match(reviewEscalation(s), /will not approve/);
  assert.match(reviewEscalation(s), /belongs in lib\/pr\.js/, 'the reviewer\'s own sentence is the point of the card');
  // A refusal with no sentence is a bug worth seeing, not a card with a blank in it.
  assert.match(reviewEscalation({ verdict: 'refused' }), /no reason was recorded/);
});

check('and a review that ended well escalates nothing, at any round', () => {
  for (const round of [1, MAX_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS + 3]) {
    const s = reviewState({ notes: withReviewBlock('', { round, verdict: 'approved', approvedBy: 'NeanderthalMan' }) });
    assert.equal(reviewEscalation(s), '', `an approval at round ${round} was escalated`);
  }
  // Nor does a review in flight: nothing has judged this, so the gate holds it — which is
  // bc-36xx.4's job and not a person's.
  assert.equal(reviewEscalation(reviewState({ notes: '' })), '');
  assert.equal(reviewEscalation(reviewState({ notes: withReviewBlock('', { round: 1, verdict: 'changes' }) })), '');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
