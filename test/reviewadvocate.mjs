#!/usr/bin/env node
/**
 * The ReviewAdvocate: a seventh agent kind, the verdict it writes, and the brief it argues from.
 *
 *     npm test
 *     node test/reviewadvocate.mjs
 *
 * bc-36xx.1. Three things here are worth a suite and none of them is visible by reading one
 * function:
 *
 * 1. **A seventh kind has to be a whole kind.** `AGENTS` is what `POST /api/console` gates
 *    on, `MARKS` draws its pill, `AGENT_ACCESS` in lib/access.js must cover the roster
 *    exactly, and lib/foundation.js says out loud that a kind added without a mark should
 *    *fail* a check rather than quietly ship as a generic 🤖. The half that matters most is
 *    the allowlist: this agent judges other agents' work and may not do any of it, so every
 *    refusal below is asserted one verb at a time rather than inferred from `writes`.
 * 2. **The verdict is a contract between three agents.** The reviewer writes it, the worker
 *    answers it, and the queue reads it. So the failures worth pinning are the ones that
 *    would be *acted on* wrongly rather than rejected: a verdict that approves while
 *    carrying a blocking comment, a refusal that never says why, and two comments sharing
 *    an id — which is one worker answer silently resolving both, and looks exactly like
 *    agreement.
 * 3. **The brief is what an unattended window is handed before it argues with somebody's
 *    code.** It is a pure function of its arguments for `epicAdvocatePrompt`'s reason, so
 *    every branch of it is asserted here with no tracker, no checkout and no window open.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reviewadv-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  REVIEW_ADVOCATE,
  VERDICT_OPEN,
  VERDICT_CLOSE,
  SEVERITIES,
  isBlocking,
  parseVerdict,
  verdictFrom,
  checkVerdict,
  formatVerdict,
  approvalNote,
  approvalComment,
  approvedReview,
  reviewAdvocatePrompt,
} = await import(LIB('reviewadvocate.js'));
const { AGENTS, baseline, mark } = await import(LIB('foundation.js'));
const { AGENT_ACCESS } = await import(LIB('access.js'));

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

console.log('\na seventh kind, and the verdict it writes\n');

/* ------------------------------------------------------------------ the kind */

check('it is a kind, not a mode — a foundation and a mark of its own', () => {
  assert.ok(AGENTS.includes(REVIEW_ADVOCATE), 'review-advocate is not in AGENTS, so nothing can own a conversation as one');
  const b = baseline(REVIEW_ADVOCATE);
  assert.equal(b.id, REVIEW_ADVOCATE);
  assert.ok(b.role && b.role.length > 200, 'a kind with no role is a mode with extra steps');
  const m = mark(REVIEW_ADVOCATE);
  assert.ok(m?.name && m?.emoji, 'lib/foundation.js says a new kind must fail this rather than draw as 🤖');
  assert.notEqual(m.emoji, mark('merge-advocate').emoji, 'the reviewer and the merge queue draw the same pill');
  assert.notEqual(m.emoji, mark('advocate').emoji);
});

check('both owners point at the module that parses it and writes its brief', () => {
  const b = baseline(REVIEW_ADVOCATE);
  assert.equal(b.protocolOwner, 'lib/reviewadvocate.js');
  assert.equal(b.briefOwner, 'lib/reviewadvocate.js');
  assert.ok(fs.existsSync(path.join(ROOT, b.briefOwner)), 'the bead an argument lands on would name a file that is not there');
});

check('AND WHAT IT MAY NOT DO IS THE WHOLE ARGUMENT FOR IT BEING ONE', () => {
  // This agent judges work other agents did. Every entry below is something it would be
  // able to do to the branch it is reviewing, and `writes: true` alone would not say so:
  // the field is one boolean over two very different claims (see lib/access.js), so the
  // refusals are pinned as patterns rather than left to it.
  const tools = baseline(REVIEW_ADVOCATE).allowedTools || [];
  const joined = tools.join(' ');
  for (const verb of ['bd create', 'bd close', 'bd delete', 'bd update', 'bd label']) {
    assert.ok(!joined.includes(verb), `the reviewer can run \`${verb}\` — it may not create, close or re-file work`);
  }
  for (const pattern of [/^Bash\(bd[\s:]*\*\)$/, /^Bash\(git push/, /^Bash\(git merge/, /^Bash\(gh pr merge/, /^Bash\(gh pr review/, /^Edit$/, /^Write$/]) {
    assert.ok(!tools.some((t) => pattern.test(t)), `the reviewer has something matching ${pattern}`);
  }
  // The one write it has, and the reason it is a kind that can leave anything behind at
  // all: its verdict is a comment on the merge-bead.
  assert.ok(tools.includes('Bash(bd comment:*)'), 'the reviewer cannot write its verdict anywhere');
  assert.ok(tools.includes('Bash(gh pr diff:*)'), 'the reviewer cannot read the diff it is reviewing');
});

check('it edits nothing, so it holds no worktree and no repo of its own', () => {
  const b = baseline(REVIEW_ADVOCATE);
  assert.equal(b.ownsRepo, false, 'an arm with no runs in it is an empty bucket in the tier-3 comparison');
  assert.equal(b.writes, true, 'its comment is its verdict — dispatch’s reading of this field');
});

check('the access register covers it, because a register that is silent reports completeness', () => {
  const row = AGENT_ACCESS[REVIEW_ADVOCATE];
  assert.ok(row, 'lib/access.js has no row for the reviewer, and agentPrincipals() throws on one');
  for (const field of ['reaches', 'grant', 'revoke']) assert.ok(String(row[field] || '').length > 20, `${field} is not a sentence`);
});

/* --------------------------------------------------------------- the verdict */

console.log('');

const VERDICT = {
  pr: 383,
  bead: 'zz-work',
  round: 1,
  approved: false,
  why: 'The retry loop can spin for ever on a 500.',
  comments: [
    { id: 'c1', file: 'lib/fetch.js', line: 88, severity: 'blocking', what: 'no ceiling on the retry', why: 'a 500 loops for ever' },
    { id: 'c2', file: 'lib/fetch.js', severity: 'suggestion', what: 'this name reads as a boolean' },
  ],
};

check('a verdict is not the merge-bead’s review block, and must not share its marker', () => {
  // bc-36xx.2 takes `beadcause:review` for the review STATE block in the merge-bead's
  // notes — rewritten every round, and outliving admission. A verdict is one review's
  // output and never changes again. Two documents under one marker is a parser that reads
  // whichever field it happened to be handed.
  assert.equal(VERDICT_OPEN, '<!-- beadcause:verdict -->');
  assert.notEqual(VERDICT_OPEN, '<!-- beadcause:review -->');
  assert.ok(VERDICT_CLOSE.includes('/beadcause:verdict'));
});

check('it round-trips through the comment body it is written as', () => {
  const { verdict } = checkVerdict(VERDICT);
  const body = formatVerdict(verdict, { owner: 'Adam' });
  const back = checkVerdict(parseVerdict(body)).verdict;
  assert.deepEqual(back, verdict, 'what a later round parses is not what this round wrote');
});

check('AND THE COMMENT SAYS AN AGENT REVIEWED IT, WHICH IS ADAM’S ANSWER ON bc-0cop', () => {
  // "the last comment on the PR should describe who is actually approving (ie an agent,
  // not me)". Every surface that carries a verdict onward starts from this text, so a
  // headline that did not say it would put a review Adam never read under his name.
  const approved = checkVerdict({ ...VERDICT, approved: true, why: '', comments: [VERDICT.comments[1]] }).verdict;
  const body = formatVerdict(approved, { owner: 'Adam' });
  assert.match(body, /an agent, not Adam/, 'an approving comment does not say who approved');
  assert.match(formatVerdict(checkVerdict(VERDICT).verdict, { owner: 'Adam' }), /an agent, not Adam/);
});

check('prose around the block does not confuse it, and rubbish inside it is not a verdict', () => {
  const body = formatVerdict(checkVerdict(VERDICT).verdict);
  assert.ok(parseVerdict(`Some words above.\n\n${body}\n\nAnd a note below.`), 'a verdict with prose round it does not parse');
  assert.equal(parseVerdict('an ordinary comment with no block in it'), null);
  assert.equal(parseVerdict(`${VERDICT_OPEN}\n\`\`\`json\n{ nope\n\`\`\`\n${VERDICT_CLOSE}`), null, 'a hand-edited block can stop a tick');
  assert.equal(parseVerdict(`${VERDICT_OPEN}\n\`\`\`json\n{"comments":[]}\n\`\`\`\n${VERDICT_CLOSE}`), null, 'a block with no verdict in it parses as one');
});

check('the thread’s verdict is the last one, because a review is re-run', () => {
  const first = formatVerdict(checkVerdict(VERDICT).verdict);
  const second = formatVerdict(checkVerdict({ ...VERDICT, round: 2, approved: true, why: '', comments: [] }).verdict);
  const found = verdictFrom([{ text: 'delivered' }, { body: first }, { comment: second }]);
  assert.equal(found.approved, true, 'the first round’s refusal is still the verdict');
  assert.equal(found.round, 2);
});

check('APPROVED WITH A BLOCKING COMMENT IS REFUSED, BECAUSE NOTHING SHOULD PICK A HALF', () => {
  // The gate reads `approved` and the worker reads the comments, so a verdict saying both
  // merges the branch while telling its author it must not.
  const { verdict, error } = checkVerdict({ ...VERDICT, approved: true, why: '' });
  assert.equal(verdict, null);
  assert.match(error, /approves and carries a blocking comment/);
  // And an approval over suggestions and questions is fine — they never hold a merge.
  const ok = checkVerdict({ ...VERDICT, approved: true, why: '', comments: [VERDICT.comments[1]] });
  assert.equal(ok.error, '');
  assert.equal(ok.verdict.approved, true);
});

check('a refusal has to say why', () => {
  const { verdict, error } = checkVerdict({ ...VERDICT, why: '   ' });
  assert.equal(verdict, null);
  assert.match(error, /does not say why/);
});

check('TWO COMMENTS SHARING AN ID IS ONE ANSWER RESOLVING BOTH', () => {
  const { verdict, error } = checkVerdict({
    ...VERDICT,
    comments: [VERDICT.comments[0], { ...VERDICT.comments[1], id: 'c1' }],
  });
  assert.equal(verdict, null);
  assert.match(error, /share the id/);
});

check('…but a forgotten id is numbered rather than costing a whole round', () => {
  const { verdict, error } = checkVerdict({
    ...VERDICT,
    comments: VERDICT.comments.map(({ id, ...rest }) => rest),
  });
  assert.equal(error, '');
  assert.deepEqual(verdict.comments.map((c) => c.id), ['c1', 'c2']);
});

check('a severity outside the vocabulary is refused rather than guessed at', () => {
  const { verdict, error } = checkVerdict({
    ...VERDICT,
    comments: [{ ...VERDICT.comments[0], severity: 'important' }],
  });
  assert.equal(verdict, null, 'defaulting it either way is unsafe in one direction or the other');
  assert.match(error, /important/);
  assert.deepEqual(SEVERITIES, ['blocking', 'suggestion', 'question']);
  assert.ok(isBlocking(VERDICT.comments[0]) && !isBlocking(VERDICT.comments[1]));
});

check('a comment that says nothing is refused, and a line is a line or nothing', () => {
  assert.equal(checkVerdict({ ...VERDICT, comments: [{ id: 'c1', severity: 'question', what: '  ' }] }).verdict, null);
  const { verdict } = checkVerdict({ ...VERDICT, comments: [{ ...VERDICT.comments[0], line: 'eighty-eight' }] });
  assert.equal(verdict.comments[0].line, null, 'a line nothing can jump to is worse than none');
});

/* -------------------------------------------------------------- the approval */

console.log('');

const APPROVED = checkVerdict({ ...VERDICT, round: 2, approved: true, why: '', comments: [VERDICT.comments[1]] }).verdict;

check('the review body on GitHub says an agent approved, and does not carry the record', () => {
  const note = approvalNote(APPROVED, { owner: 'Adam', reviewer: 'NeanderthalMan', bead: 'zz-merge' });
  assert.match(note, /an agent, not Adam/, 'the body beside the green tick does not say what approved');
  assert.match(note, /`NeanderthalMan`/, 'the login is not named, so nothing says who that account is');
  assert.match(note, /Adam has not read this diff/);
  assert.match(note, /round 2/);
  // One home for the machine block. A second copy on the pull request is a second thing a
  // later round could parse, which is how two records of one review start to disagree.
  assert.ok(!note.includes(VERDICT_OPEN), 'the verdict block is on the pull request as well as the bead');
  assert.ok(!note.includes('```json'));
});

check('and it is the same headline the merge-bead carries, from one builder', () => {
  // The sentence Adam asked for must not be true of one surface and missing from the other.
  const head = (s) => s.split('\n')[0];
  assert.equal(head(approvalNote(APPROVED, { owner: 'Adam' })), head(formatVerdict(APPROVED, { owner: 'Adam' })));
});

check('THE LAST COMMENT SAYS THE LOGIN IS NOT A PERSON, WHICH IS THE REQUIREMENT ITSELF', () => {
  // "the last comment on the PR should describe who is actually approving (ie an agent, not
  // me)". The review's own timeline entry says "NeanderthalMan approved these changes" —
  // a name, with nothing on the page to say it is an agent's identity.
  const text = approvalComment({ owner: 'Adam', reviewer: 'NeanderthalMan', bead: 'zz-merge' });
  assert.match(text, /an agent's, not Adam's/);
  assert.match(text, /`NeanderthalMan` is the account/);
  assert.match(text, /review-advocate/, 'the comment does not name the kind that approved');
  assert.match(text, /Nobody at a keyboard approved this/);
  assert.match(text, /zz-merge/, 'nothing points at where the argument is recorded');
});

check('it is not the same text as the review body — the two answer different questions', () => {
  const opts = { owner: 'Adam', reviewer: 'NeanderthalMan', bead: 'zz-merge' };
  assert.notEqual(approvalComment(opts), approvalNote(APPROVED, opts));
});

check('and where a human approval is required too, it says the agent’s is not sufficient', () => {
  // Adam's answer of 2026-08-17: an agent's approval is necessary but not sufficient where a
  // space has human PR approvals switched on, and everywhere else it releases the merge.
  const human = approvalComment({ owner: 'Adam', reviewer: 'NeanderthalMan', human: true });
  assert.match(human, /necessary rather than sufficient/);
  assert.ok(!/releases a pull request/.test(human), 'it tells Adam the agent released a PR he still has to admit');
  assert.match(approvalComment({ owner: 'Adam', reviewer: 'NeanderthalMan' }), /releases a pull request/);
});

check('the review block records the approval, with an anchor a reader can check', () => {
  const state = { round: 1, verdict: null, comments: [{ id: 'c2', body: 'this name reads as a boolean', answer: 'declined', note: 'it is a count' }] };
  const next = approvedReview(state, {
    reviewer: 'NeanderthalMan',
    at: '2026-08-17T15:02:03Z',
    url: 'https://github.com/mordam/beadcause/pull/42#pullrequestreview-909',
    submitted: true,
    round: 2,
  });
  assert.equal(next.verdict, 'approved', 'the one field the gate reads');
  assert.equal(next.approvedBy, 'NeanderthalMan');
  assert.equal(next.approvedAt, '2026-08-17T15:02:03Z');
  assert.match(next.approvalUrl, /pullrequestreview-909/, 'the cheap answer is not checkable against GitHub');
  assert.equal(next.round, 2);
  // An approval means nothing blocking is left, not that every suggestion was taken.
  assert.deepEqual(next.comments, state.comments, 'approving quietly resolved a declined suggestion');
});

check('AND A ONE-LOGIN MAC RECORDS THE APPROVAL RATHER THAN LOSING IT', () => {
  // `reviewerFor` returning null is the ordinary answer everywhere except this Mac. The
  // verdict approved; the only thing missing is GitHub's copy of it.
  const next = approvedReview({ round: 1 }, { submitted: false, at: '2026-08-17T15:02:03Z', reviewer: 'NeanderthalMan' });
  assert.equal(next.verdict, 'approved', 'a delivery dies over a second account nobody promised');
  assert.equal(next.approvedBy, REVIEW_ADVOCATE, 'it credits a login that never reviewed anything');
  assert.equal(next.reviewer, '');
  assert.equal(next.approvalUrl, '', 'an approval with an anchor that was never submitted');
  assert.equal(next.round, 1, 'a round the loop did not report was invented');
});

check('an approval in no round at all reads as a pull request nobody reviewed', () => {
  assert.equal(approvedReview({}, { submitted: true, reviewer: 'x' }).round, 1);
  assert.equal(approvedReview({ round: 3 }, { submitted: true, reviewer: 'x' }).round, 3);
});

/* ----------------------------------------------------------------- the brief */

console.log('');

const ISSUE = { id: 'zz-merge', title: 'merge zz-work' };
const SPEC = {
  number: 383,
  repo: 'beadcause',
  bead: 'zz-work',
  branch: 'worktree-zz',
  base: 'main',
  url: 'https://github.com/mordam/beadcause/pull/383',
  tests: 'npm test, 291/291 green',
  risk: 'it touches the router',
};

check('the brief is a pure function — no tracker, no checkout, no window', () => {
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.match(text, /pull request #383/);
  assert.match(text, /zz-merge/);
  assert.match(text, /zz-work/);
  assert.match(text, /worktree-zz` → `main/);
  assert.match(text, /291\/291 green/, 'the worker’s own account of what it ran is not carried over');
  assert.match(text, /it touches the router/);
});

check('IT SAYS WHAT A GOOD REVIEW COMMENT IS, BECAUSE NOTHING ELSE WILL', () => {
  // The one thing this brief exists for. An agent asked to review a diff will find
  // something to say about every hunk of it; the severity vocabulary is the mechanism and
  // this paragraph is what makes it mean something.
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.match(text, /`blocking` is a promise/i, 'nothing in the brief says what may be a blocking comment');
  assert.match(text, /Style, naming, structure and taste/, 'a reviewer that blocks on taste burns a round for nothing');
  assert.match(text, /Few and real beats many and plausible/);
  assert.match(text, /is a bead, not a\n*\s*review comment/, 'nothing stops the review widening into the file around the diff');
});

check('and it says exactly how to write the verdict down', () => {
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.ok(text.includes(VERDICT_OPEN) && text.includes(VERDICT_CLOSE), 'the markers are not in the brief');
  for (const s of SEVERITIES) assert.ok(text.includes(s), `${s} is not named in the brief`);
  assert.match(text, /"pr": 383/, 'the example block is not this pull request');
  assert.match(text, /approves while carrying a blocking comment is refused/, 'the one contradiction is not explained');
});

check('A LATER ROUND IS ABOUT THE ANSWERS, NOT A SECOND FIRST REVIEW', () => {
  // Adam's loop: the worker declines a comment, and the declination is scrutinised. A
  // reviewer handed its own comments back and told to review the diff again raises a new
  // set every round, which is the loop that never ends.
  const state = {
    round: 2,
    comments: [{ id: 'c1', file: 'lib/fetch.js', line: 88, severity: 'blocking', what: 'no ceiling on the retry', answer: 'the caller times out at 30s' }],
  };
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC, state, { maxRounds: 2, owner: 'Adam' });
  assert.match(text, /Round: 2 of 2/);
  assert.match(text, /the last one before this becomes a card/);
  assert.match(text, /The worker: the caller times out at 30s/, 'the worker’s answer is not in the brief it is meant to scrutinise');
  assert.match(text, /Do not raise new blocking comments about code that was in the diff the first time/);
  assert.ok(!/What a good review comment is here/.test(text), 'round two is handed the first round’s instructions');
});

check('ROUND ONE RUNS /code-review AS ITS FINDING STEP, NOT AS THE REVIEW ITSELF', () => {
  // Adam's answer 7: "the review engine is the ReviewAdvocate's own protocol... the brief
  // instructs the session to run /code-review as its FINDING step, then do the two things
  // that skill does not — judge the delivery against the bead's own acceptance criteria."
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.match(text, /\/code-review/, 'nothing tells the session to run the skill');
  assert.match(text, /not the review itself|not as the review/, 'the skill\'s findings are treated as the verdict itself');
});

check('AND SEPARATELY, IT MUST JUDGE THE DIFF AGAINST THE BEAD\'S OWN ACCEPTANCE CRITERIA', () => {
  // The half /code-review never does: is this actually what zz-work was asked for.
  const round1 = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.match(round1, /acceptance criteria/i, 'round one never asks whether the diff delivers the bead');
  assert.match(round1, /zz-work/, 'the judgement does not name the bead it is judged against');

  const state = {
    round: 2,
    comments: [{ id: 'c1', file: 'lib/fetch.js', line: 88, severity: 'blocking', what: 'no ceiling on the retry', answer: 'the caller times out at 30s' }],
  };
  const round2 = reviewAdvocatePrompt('beadcause', ISSUE, SPEC, state, { maxRounds: 2, owner: 'Adam' });
  assert.match(round2, /acceptance criteria/i, 'the acceptance judgement does not survive into round two');
  assert.match(round2, /zz-work/);
});

check('and the cap arrives as a decision rather than as a defeat', () => {
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC, {}, { maxRounds: 2, owner: 'Adam' });
  assert.match(text, /There are 2 rounds, and then this becomes a card for Adam/);
  assert.match(text, /good ending and not a failure/);
  // And with no cap configured there is no sentence about one — a brief that named a
  // number nothing enforces would be teaching the agent something untrue.
  assert.ok(!/becomes a card for/.test(reviewAdvocatePrompt('beadcause', ISSUE, SPEC)));
});

check('IT MAY NOT MERGE, EDIT, OR SUBMIT THE REVIEW ITSELF', () => {
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC);
  assert.match(text, /may not merge, push, or close anything/);
  assert.match(text, /may not edit the branch/);
  assert.match(text, /may not submit the review on GitHub yourself/, 'nothing says why it has no `gh pr review` grant');
});

check('what earlier runs learned is handed to it, attributed to its own kind', () => {
  // The trap in lib/session.js's three doors: two of the three say "worker", so a fourth
  // copied from one hands a new agent somebody else's memory under a heading claiming it
  // is its own. Here the brief builder is the one that names it.
  // Named rather than merely alike, so the selection is deterministic: `relevantNotes`
  // always picks a note that mentions the bead, whatever the similarity floor is doing.
  const notes = {
    'flaky-suite': { value: 'On zz-merge: test/outagepush.mjs is a load flake here; re-run it alone before believing it.', at: '2026-08-17' },
  };
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC, {}, { notes });
  assert.match(text, /load flake here/);
  assert.match(text, /another ReviewAdvocate wrote down for its own future self/);
  assert.ok(!/another worker wrote down/.test(text), 'the reviewer is handed the worker’s memory under its own name');
});

check('and a repo nobody has noted anything about gets no heading at all', () => {
  const text = reviewAdvocatePrompt('beadcause', ISSUE, SPEC, {}, { notes: {}, debriefs: [] });
  assert.ok(!text.includes('What earlier sessions in this repo already worked out'), 'an empty section is still drawn');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
