#!/usr/bin/env node
/**
 * The worker's answer to a review — what it may write, and what it is told before it writes it.
 *
 *     npm test
 *     node test/reviewanswer.mjs
 *
 * bc-36xx.6. Not to be confused with test/handback.mjs, which is about the *claim* a dead
 * window was still holding; this is the review round, and the module is lib/reviewanswer.js.
 * Five things here are worth a suite, and each is a way the review loop goes wrong quietly
 * rather than loudly:
 *
 * 1. **The worker cannot resolve anything.** `resolved` is the reviewer's field, and a
 *    worker that could write it could end its own review — the self-certification the whole
 *    queue exists to remove, arrived at from the worker's end. It is refused rather than
 *    dropped, because a session whose `resolved` was ignored believes a thread is closed
 *    that is still open.
 * 2. **An answer that lands nowhere is refused.** An id the block does not carry, an answer
 *    outside the three words, a decline with no reason: each would otherwise be a round
 *    spent on a misunderstanding neither side can see.
 * 3. **Answering costs nothing.** `round`, `verdict` and every `resolved` already in the
 *    block come through untouched, which is what makes "a reply that pushes no commits does
 *    not consume a round" true — the cap counts the reviewer's passes.
 * 4. **The declined comment survives on its own.** Adam's rule is that declined comments and
 *    further changes are raised to the reviewer for scrutiny; this pins that it falls out of
 *    `commentsForReviewer` rather than needing an escalation path of its own.
 * 5. **The brief says the three things nothing else will say** — the branch already exists,
 *    declining is allowed, and finishing is not the worker's to declare — and the
 *    *delivering* worker is warned that any of this is coming.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { parseAnswers, checkAnswers, withAnswers, answerComment, reviewAnswerPrompt, commentAt } = await import(
  LIB('reviewanswer.js')
);
const { REVIEW_ANSWERS, reviewState, withReviewBlock, commentsForWorker, commentsForReviewer } = await import(
  LIB('mergebead.js')
);
const { workPromptFor } = await import(LIB('session.js'));

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

const STATE = {
  round: 1,
  verdict: 'changes',
  reviewer: 'NeanderthalMan',
  at: '2026-08-17T18:00:00.000Z',
  refused: 'two of these have to change before I would approve it',
  comments: [
    { id: 'c1', path: 'lib/thing.js', line: 42, body: 'this throws on an empty list', answer: '', note: '', resolved: false },
    { id: 'c2', path: '', line: null, body: 'why is the lock taken twice', answer: '', note: '', resolved: false },
    { id: 'c3', path: 'test/thing.mjs', line: 9, body: 'this test asserts nothing', answer: 'changed', note: 'rewrote it', resolved: true },
  ],
};

const SPEC = {
  workspace: 'beadcause',
  bead: 'bc-7qo',
  repo: 'mordam/beadcause',
  number: 42,
  url: 'https://github.com/mordam/beadcause/pull/42',
  branch: 'worktree-thing-a3f',
  base: 'main',
};
const ISSUE = { id: 'bc-mrg1', title: 'Merge #42 — bc-7qo: the thing' };

console.log('\nthe worker answers its reviewer\n');

/* ------------------------------------------------------------------ what it may write */

check('the three answers are the review block’s own vocabulary, not a second list', () => {
  assert.deepEqual(REVIEW_ANSWERS, ['changed', 'clarify', 'declined']);
});

check('a list of answers is read off the document the brief prints', () => {
  const raw = parseAnswers('- id: c1\n  answer: changed\n  note: fixed the empty case\n');
  assert.equal(raw.length, 1);
  assert.equal(raw[0].id, 'c1');
});

check('one answer written as a single mapping is read too — that is what a session writes for one comment', () => {
  const raw = parseAnswers('id: c1\nanswer: declined\nnote: the caller already holds it\n');
  assert.equal(raw.length, 1);
  assert.equal(raw[0].answer, 'declined');
});

check('something that is not YAML is null rather than a throw, so the command can say a sentence', () => {
  assert.equal(parseAnswers('- id: [c1\n  answer:: changed'), null);
  assert.equal(parseAnswers(''), null);
});

check('a good answer normalises to id, answer and note', () => {
  const { answers, error } = checkAnswers(parseAnswers('- id: c1\n  answer: Changed\n  note:  fixed  it \n'), STATE);
  assert.equal(error, '');
  assert.deepEqual(answers, [{ id: 'c1', answer: 'changed', note: 'fixed it' }]);
});

/* ------------------------------------------------------ the one answer it may not give */

check('the worker may not resolve a comment, and the refusal says whose field it is', () => {
  const { answers, error } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done', resolved: true }], STATE);
  assert.deepEqual(answers, []);
  assert.match(error, /reviewer's field/i);
});

check('and it may not resolve one by writing resolved: false either — the field is not its to mention', () => {
  const { error } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done', resolved: false }], STATE);
  assert.match(error, /resolved/);
});

check('nothing a worker writes can set resolved on the state that comes back', () => {
  const { answers } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done' }], STATE);
  const next = withAnswers(STATE, answers);
  assert.equal(next.comments.find((c) => c.id === 'c1').resolved, false);
  assert.equal(next.comments.filter((c) => c.resolved).length, 1, 'the reviewer’s own resolved comment moved');
});

check('a comment the reviewer already resolved cannot be answered at all', () => {
  const { error } = checkAnswers([{ id: 'c3', answer: 'changed', note: 'again' }], STATE);
  assert.match(error, /already resolved/);
});

/* ------------------------------------------------------- answers that would land nowhere */

check('an id the review does not carry is refused, and the refusal lists the ones it does', () => {
  const { error } = checkAnswers([{ id: 'c9', answer: 'changed', note: 'done' }], STATE);
  assert.match(error, /no comment `c9`/);
  assert.match(error, /`c1`/);
});

check('an answer outside the three words is refused rather than guessed at', () => {
  const { error } = checkAnswers([{ id: 'c1', answer: 'rejected', note: 'no' }], STATE);
  assert.match(error, /changed, clarify, declined/);
});

check('a decline with no reason is refused — the reviewer cannot act on it', () => {
  const { error } = checkAnswers([{ id: 'c1', answer: 'declined' }], STATE);
  assert.match(error, /round spent on nothing/);
});

check('a clarify with no question is refused for the same reason', () => {
  const { error } = checkAnswers([{ id: 'c2', answer: 'clarify' }], STATE);
  assert.ok(error);
});

check('a changed may stand on its own, because the diff is its account', () => {
  const { error, answers } = checkAnswers([{ id: 'c1', answer: 'changed' }], STATE);
  assert.equal(error, '');
  assert.equal(answers[0].note, '');
});

check('two answers to one comment is refused rather than last-wins', () => {
  const { error } = checkAnswers(
    [
      { id: 'c1', answer: 'changed', note: 'a' },
      { id: 'c1', answer: 'declined', note: 'b' },
    ],
    STATE
  );
  assert.match(error, /twice/);
});

check('an empty document is refused, so a worker cannot record having answered nothing', () => {
  assert.ok(checkAnswers([], STATE).error);
  assert.ok(checkAnswers(null, STATE).error);
});

/* --------------------------------------------------------------- what answering costs */

check('answering does not advance the round — the cap counts the reviewer’s passes', () => {
  const { answers } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done' }], STATE);
  const next = withAnswers(STATE, answers);
  assert.equal(next.round, STATE.round);
  assert.equal(next.verdict, STATE.verdict);
  assert.equal(next.reviewer, STATE.reviewer);
});

check('and a comment it did not answer is left exactly as it was', () => {
  const { answers } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done' }], STATE);
  const next = withAnswers(STATE, answers);
  assert.deepEqual(next.comments.find((c) => c.id === 'c2'), STATE.comments[1]);
});

check('the answers survive the block round trip the daemon actually writes', () => {
  const { answers } = checkAnswers(
    [
      { id: 'c1', answer: 'changed', note: 'guarded the empty list' },
      { id: 'c2', answer: 'declined', note: 'the caller holds the lock already' },
    ],
    STATE
  );
  const notes = withReviewBlock('a line a human wrote\n', withAnswers(STATE, answers));
  const back = reviewState({ notes });
  assert.equal(back.round, 1);
  assert.equal(back.comments.find((c) => c.id === 'c1').answer, 'changed');
  assert.equal(back.comments.find((c) => c.id === 'c2').note, 'the caller holds the lock already');
  assert.equal(back.comments.find((c) => c.id === 'c3').resolved, true);
  assert.match(notes, /a line a human wrote/);
});

check('a declined comment goes back in front of the reviewer on its own, with no escalation path', () => {
  const { answers } = checkAnswers([{ id: 'c1', answer: 'declined', note: 'it cannot be empty here' }], STATE);
  const next = withAnswers(STATE, answers);
  assert.deepEqual(commentsForReviewer(next).map((c) => c.id), ['c1'], 'the declined comment is not what the reviewer is handed');
  assert.deepEqual(commentsForWorker(next).map((c) => c.id), ['c2'], 'the unanswered one stopped being the worker’s');
});

check('a changed comment is raised for scrutiny too — a change somebody made is a change somebody checks', () => {
  const { answers } = checkAnswers([{ id: 'c1', answer: 'changed', note: 'done' }], STATE);
  assert.deepEqual(commentsForReviewer(withAnswers(STATE, answers)).map((c) => c.id), ['c1']);
});

/* -------------------------------------------------------------------- what it reads as */

check('the comment on the bead says what was answered and that nothing is resolved', () => {
  const body = answerComment([{ id: 'c1', answer: 'changed', note: 'done' }, { id: 'c2', answer: 'declined', note: 'no' }], {
    round: 1,
    sha: '0123456789abcdef',
  });
  assert.match(body, /1 changed, 1 declined/);
  assert.match(body, /0123456789ab/);
  assert.match(body, /Nothing here is resolved/);
});

check('and it says out loud when a reply pushed nothing', () => {
  assert.match(answerComment([{ id: 'c1', answer: 'clarify', note: 'what did you mean' }], { pushed: false }), /words only/);
});

/* ------------------------------------------------------------------------- the brief */

const brief = reviewAnswerPrompt('beadcause', ISSUE, SPEC, STATE, { owner: 'Adam', maxRounds: 2 });

check('it names the pull request, the branch and the bead the work is on', () => {
  assert.match(brief, /#42/);
  assert.match(brief, /worktree-thing-a3f/);
  assert.match(brief, /bc-7qo/);
});

check('it says the branch already exists, so nothing opens a second one', () => {
  assert.match(brief, /it already exists/i);
  assert.match(brief, /do not open a new branch/i);
  assert.match(brief, /do not re-run the delivery command/i);
});

check('it prints the comments the worker owes an answer on, and not the resolved one', () => {
  assert.match(brief, /this throws on an empty list/);
  assert.match(brief, /why is the lock taken twice/);
  assert.ok(!/this test asserts nothing/.test(brief), 'a resolved comment was handed back to the worker');
});

check('it offers all three answers and says declining is legitimate', () => {
  for (const word of REVIEW_ANSWERS) assert.match(brief, new RegExp(`\`${word}\``));
  assert.match(brief, /Declining is a legitimate answer/);
});

check('it says the worker does not resolve anything and cannot declare the review finished', () => {
  assert.match(brief, /You do not resolve anything/);
  assert.match(brief, /Only the ReviewAdvocate/);
});

check('it names the command that writes the answers, against the bead the review is on', () => {
  assert.match(brief, /beadcause-answer -w beadcause -b bc-mrg1/);
  assert.match(brief, /answer: changed\|clarify\|declined/);
});

check('it forbids the merge and the close, which are somebody else’s', () => {
  assert.match(brief, /Never merge or push `main`/);
  assert.match(brief, /Do not close bc-7qo/);
});

check('it says how many rounds are left and what happens after them', () => {
  assert.match(brief, /There are 2 rounds/);
  assert.match(brief, /card for Adam/);
});

check('with no cap given it promises no cap, rather than inventing one', () => {
  assert.ok(!/rounds, and then/.test(reviewAnswerPrompt('beadcause', ISSUE, SPEC, STATE)));
});

check('a review with nothing outstanding says so rather than inviting a push for its own sake', () => {
  const done = { ...STATE, comments: STATE.comments.map((c) => ({ ...c, resolved: true })) };
  assert.match(reviewAnswerPrompt('beadcause', ISSUE, SPEC, done), /Nothing is outstanding/);
});

check('the brief is a pure function of its arguments — no tracker, no checkout, no window', () => {
  assert.equal(reviewAnswerPrompt('beadcause', ISSUE, SPEC, STATE, { owner: 'Adam', maxRounds: 2 }), brief);
});

check('a comment about a file reads as path:line, and one about the change as a whole reads as nothing', () => {
  assert.equal(commentAt(STATE.comments[0]), 'lib/thing.js:42');
  assert.equal(commentAt(STATE.comments[1]), '');
});

/* --------------------------------------------------------- the delivering worker's half */

check('the delivering worker is told a review is coming and that it will be handed back', () => {
  const text = workPromptFor(
    'beadcause',
    { id: 'bc-7qo', title: 'the thing' },
    1,
    { repo: 'mordam/beadcause', base: 'main', method: 'merge', autoMerge: true, deliver: 'beadcause-deliver' },
    'Adam'
  );
  assert.match(text, /ReviewAdvocate/);
  assert.match(text, /a window is opened again on bc-7qo/);
  assert.match(text, /`changed`/);
  assert.match(text, /never the worker's claim/);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
